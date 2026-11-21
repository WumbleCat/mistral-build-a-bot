"""Vision / reasoning API adapters.

``VisionClient`` is the only thing the pipeline knows about. Two implementations:

* ``OpenAICompatVisionClient`` - any OpenAI-compatible ``/chat/completions`` endpoint.
  Defaults target the Mistral API (``https://api.mistral.ai/v1``).
* ``MockVisionClient`` - canned, clearly-labelled responses for offline development.
"""

from __future__ import annotations

import base64
import json
import logging
import ssl
import time
from typing import Protocol

import httpx
from pydantic import BaseModel

from .config import Settings
from .ingest import ImageInput
from .models import ImageObservation, InferenceAudit, VisibilityAudit

log = logging.getLogger(__name__)


class VisionAPIError(RuntimeError):
    """Transport / HTTP level failure talking to the vision API (never contains the key)."""


class VisionClient(Protocol):
    name: str

    def analyze(
        self,
        images: list[ImageInput],
        system_prompt: str,
        response_schema: type[BaseModel],
        user_prompt: str = "",
    ) -> str:
        """Return the model's raw text reply (expected to be a JSON document)."""
        ...


def system_trust_context() -> ssl.SSLContext:
    """TLS context trusting the OS certificate store plus certifi.

    Using the OS store keeps verification ON while working behind antivirus / corporate
    TLS inspection, whose root certificates are installed in the OS store only.
    """
    context = ssl.create_default_context()
    try:
        import certifi

        context.load_verify_locations(certifi.where())
    except Exception:  # pragma: no cover - certifi is optional hardening
        pass
    return context


class OpenAICompatVisionClient:
    """Chat-completions client for Mistral and other OpenAI-compatible vision APIs."""

    _RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str,
        *,
        json_mode: str = "json_object",
        timeout_s: float = 120.0,
        transport_retries: int = 3,
        http_client: httpx.Client | None = None,
        sleep=time.sleep,
    ) -> None:
        self.name = f"{base_url} ({model})"
        self._model = model
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._json_mode = json_mode
        self._transport_retries = max(1, transport_retries)
        self._sleep = sleep
        self._headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        self._client = http_client or httpx.Client(timeout=timeout_s, verify=system_trust_context())

    def with_model(self, model: str) -> "OpenAICompatVisionClient":
        clone = object.__new__(OpenAICompatVisionClient)
        clone.__dict__.update(self.__dict__)
        clone._model = model
        clone.name = self.name.rsplit(" (", 1)[0] + f" ({model})"
        return clone

    def analyze(
        self,
        images: list[ImageInput],
        system_prompt: str,
        response_schema: type[BaseModel],
        user_prompt: str = "",
    ) -> str:
        content: list[dict] = [{"type": "text", "text": user_prompt or "Analyze the input."}]
        for image in images:
            encoded = base64.b64encode(image.data).decode("ascii")
            content.append({"type": "text", "text": f"image_id: {image.image_id}"})
            content.append(
                {"type": "image_url", "image_url": {"url": f"data:{image.mime_type};base64,{encoded}"}}
            )
        payload: dict = {
            "model": self._model,
            "temperature": 0,
            "top_p": 1,  # some Mistral models reject greedy sampling unless top_p is explicit
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ],
        }
        if self._json_mode == "json_object":
            payload["response_format"] = {"type": "json_object"}
        return self._post(payload)

    def _post(self, payload: dict) -> str:
        last_error = "no attempt made"
        for attempt in range(1, self._transport_retries + 1):
            try:
                response = self._client.post(self._url, headers=self._headers, json=payload)
            except httpx.HTTPError as exc:
                last_error = f"network error: {exc.__class__.__name__}: {exc}"
            else:
                if response.status_code == 200:
                    return self._extract_text(response)
                last_error = f"HTTP {response.status_code}: {_safe_error_text(response)}"
                if response.status_code in (401, 403):
                    raise VisionAPIError(
                        f"The vision API rejected the configured credentials ({last_error}). "
                        "Check MISTRAL_API_KEY / VISION_API_KEY."
                    )
                if response.status_code not in self._RETRYABLE_STATUS:
                    raise VisionAPIError(f"Vision API request failed: {last_error}")
            if attempt < self._transport_retries:
                delay = min(2.0 ** attempt, 20.0)
                log.warning("vision API attempt %d failed (%s); retrying in %.0fs", attempt, last_error, delay)
                self._sleep(delay)
        raise VisionAPIError(
            f"Vision API request failed after {self._transport_retries} attempts: {last_error}"
        )

    @staticmethod
    def _extract_text(response: httpx.Response) -> str:
        try:
            message = response.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise VisionAPIError("Vision API returned an unexpected response shape") from None
        if isinstance(message, list):  # some providers return content chunks
            message = "".join(
                chunk.get("text", "") for chunk in message
                if isinstance(chunk, dict) and chunk.get("type", "text") == "text"
            )
        if not isinstance(message, str):
            raise VisionAPIError("Vision API returned non-text content")
        return message

    def list_models(self) -> list[dict]:
        url = self._url.rsplit("/chat/completions", 1)[0] + "/models"
        try:
            response = self._client.get(url, headers=self._headers)
        except httpx.HTTPError as exc:
            raise VisionAPIError(f"network error: {exc.__class__.__name__}: {exc}") from None
        if response.status_code != 200:
            raise VisionAPIError(f"HTTP {response.status_code}: {_safe_error_text(response)}")
        return response.json().get("data", [])


def _safe_error_text(response: httpx.Response) -> str:
    """Short provider error message; request headers (and so the key) are never included."""
    try:
        body = response.json()
        detail = body.get("message") or body.get("error") or body.get("detail") or body
        text = detail if isinstance(detail, str) else json.dumps(detail)
    except ValueError:
        text = response.text
    return text[:300]


# --------------------------------------------------------------------------
# Mock mode
# --------------------------------------------------------------------------

_MOCK_TOP_VIEW = {
    "view": "top",
    "parts": [
        {
            "category": "wheel", "name": "rubber wheel",
            "description": "Four chunky black treaded tyres, one at each corner of the frame.",
            "visible_quantity": 4, "bbox_xyxy_norm": None, "confidence": 0.93,
        },
        {
            "category": "chassis", "name": "green chassis frame",
            "description": "Flat green frame/plate that everything is mounted on.",
            "visible_quantity": 1, "bbox_xyxy_norm": [0.18, 0.12, 0.82, 0.88], "confidence": 0.9,
        },
        {
            "category": "breadboard", "name": "solderless breadboard",
            "description": "White solderless breadboard near the centre with components plugged in.",
            "visible_quantity": 1, "bbox_xyxy_norm": [0.36, 0.3, 0.64, 0.5], "confidence": 0.88,
        },
        {
            "category": "relay_module", "name": "relay module board",
            "description": "Blue PCB carrying relay blocks with screw terminals, wired to the breadboard.",
            "visible_quantity": 1, "bbox_xyxy_norm": [0.38, 0.56, 0.62, 0.74], "confidence": 0.8,
        },
        {
            "category": "relay", "name": "blue relay block",
            "description": "Two blue cube relays soldered onto the relay module board.",
            "visible_quantity": 2, "parent_assembly": "relay module board", "confidence": 0.78,
        },
        {
            "category": "wiring", "name": "jumper wires",
            "description": "Bundle of multicoloured jumper wires between breadboard and relay board; count not determinable.",
            "visible_quantity": None, "confidence": 0.85,
        },
        {
            "category": "led", "name": "LED",
            "description": "Three small lit indicator LEDs on the breadboard.",
            "visible_quantity": 3, "confidence": 0.7,
        },
    ],
    "notes": ["MOCK DATA: canned top-view response, not derived from the supplied image."],
}

_MOCK_UNDERSIDE_VIEW = {
    "view": "underside",
    "parts": [
        {
            "category": "wheel", "name": "rubber wheel",
            "description": "The same four black treaded tyres seen from below.",
            "visible_quantity": 4, "confidence": 0.9,
        },
        {
            "category": "motor", "name": "DC gear motor",
            "description": "Two yellow plastic gear-motor housings attached to the rear axle positions.",
            "visible_quantity": 2, "confidence": 0.75,
        },
        {
            "category": "chassis", "name": "green chassis frame",
            "description": "Underside of the green frame.",
            "visible_quantity": 1, "confidence": 0.85,
        },
        {
            "category": "battery_holder", "name": "battery holder",
            "description": "Black plastic cell holder fixed under the frame; cell type and count unreadable.",
            "visible_quantity": 1, "confidence": 0.6,
        },
    ],
    "notes": ["MOCK DATA: canned underside response, not derived from the supplied image."],
}

_MOCK_AUDIT = {
    "inferred_components": [
        {
            "category": "motor_driver", "name": "motor driver / motor switching stage",
            "evidence_type": "unknown",
            "rationale": "Something must switch motor current; a relay board is visible but its role is not established.",
        },
        {
            "category": "microcontroller", "name": "controller board",
            "evidence_type": "unknown",
            "rationale": "No controller board is identifiable; it may be hidden or off-frame.",
        },
        {
            "category": "fastener", "name": "mounting screws, nuts and standoffs",
            "evidence_type": "inferred",
            "rationale": "Boards and wheels must be fixed to the frame; fasteners are not visible from this view.",
        },
    ],
    "connections": [],
    "issues": [
        {
            "severity": "warning", "component_ids": [],
            "message": "Wire routing between the relay board and the rest of the electronics cannot be traced from the photo.",
            "next_action": "Sketch or photograph the wiring so each relay terminal's load is known.",
        }
    ],
    "requested_views": [
        {"view": "underside", "reason": "Shows drive motors, gearboxes, axles and fasteners."},
        {"view": "close-up of PCB labels", "reason": "Readable silkscreen identifies the controller and relay board."},
    ],
}


class MockVisionClient:
    """Deterministic offline stand-in. Its output is canned and labelled as mock data."""

    name = "mock"

    def analyze(
        self,
        images: list[ImageInput],
        system_prompt: str,
        response_schema: type[BaseModel],
        user_prompt: str = "",
    ) -> str:
        if response_schema is ImageObservation:
            filename = images[0].filename.lower() if images else ""
            is_underside = any(word in filename for word in ("underside", "bottom", "under"))
            return json.dumps(_MOCK_UNDERSIDE_VIEW if is_underside else _MOCK_TOP_VIEW)
        if response_schema is InferenceAudit:
            return json.dumps(_MOCK_AUDIT)
        if response_schema is VisibilityAudit:
            return json.dumps({"checks": []})  # canned parts are all "visible"
        raise ValueError(f"MockVisionClient has no canned response for {response_schema.__name__}")


def build_vision_client(settings: Settings, *, mock: bool = False) -> VisionClient:
    """Mock mode is always explicit - a missing key never silently falls back to mock."""
    if mock or settings.mock:
        return MockVisionClient()
    return OpenAICompatVisionClient(
        api_key=settings.require_api_key(),
        model=settings.vision_model,
        base_url=settings.base_url,
        json_mode=settings.json_mode,
        timeout_s=settings.timeout_s,
    )
