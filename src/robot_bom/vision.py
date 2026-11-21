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
import re
import ssl
import time
from typing import Protocol

import httpx
from pydantic import BaseModel

from .config import DEFAULT_TIMEOUT_S, Settings
from .ingest import ImageInput
from .models import ImageObservation, InferenceAudit, VisibilityAudit

log = logging.getLogger(__name__)

CONNECT_TIMEOUT_S = 20.0
MODEL_LIST_TIMEOUT_S = 30.0
WEB_SEARCH_TIMEOUT_S = 120.0
MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$")


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
    # A reply that outlasts the read timeout is asked for once more, not three times: every
    # retry restarts the whole generation, so repeating it only multiplies the wait.
    _READ_TIMEOUT_ATTEMPTS = 2

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str,
        *,
        json_mode: str = "json_object",
        timeout_s: float = DEFAULT_TIMEOUT_S,
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
        self._timeout_s = timeout_s
        # timeout_s is how long to wait for the reply, which arrives in one piece once the
        # model has finished writing; connecting should never take that long.
        self._client = http_client or httpx.Client(
            timeout=httpx.Timeout(timeout_s, connect=min(timeout_s, CONNECT_TIMEOUT_S)),
            verify=system_trust_context(),
        )

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
        read_timeouts = 0
        for attempt in range(1, self._transport_retries + 1):
            try:
                response = self._client.post(self._url, headers=self._headers, json=payload)
            except httpx.ReadTimeout:
                read_timeouts += 1
                last_error = f"no reply within {self._timeout_s:.0f}s"
                if read_timeouts >= self._READ_TIMEOUT_ATTEMPTS:
                    raise VisionAPIError(
                        f"The model '{self._model}' did not answer within {self._timeout_s:.0f}s "
                        f"(tried {read_timeouts} times). Choose a faster model, or allow more time "
                        "with VISION_TIMEOUT_S."
                    ) from None
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

    def web_search(self, prompt: str) -> dict:
        """One turn of Mistral's Conversations API with its built-in web search tool.

        Returns the raw response; the caller reads the search results out of it. Only the
        Mistral API offers this endpoint - other providers answer with an error.
        """
        url = self._url.rsplit("/chat/completions", 1)[0] + "/conversations"
        payload = {"model": self._model, "inputs": prompt, "tools": [{"type": "web_search"}], "store": False}
        try:
            response = self._client.post(url, headers=self._headers, json=payload, timeout=WEB_SEARCH_TIMEOUT_S)
        except httpx.HTTPError as exc:
            raise VisionAPIError(f"web search failed: {exc.__class__.__name__}") from None
        if response.status_code != 200:
            raise VisionAPIError(f"web search failed: HTTP {response.status_code}: {_safe_error_text(response)}")
        try:
            body = response.json()
        except ValueError:
            raise VisionAPIError("web search returned invalid JSON") from None
        return body if isinstance(body, dict) else {}

    def list_models(self) -> list[dict]:
        url = self._url.rsplit("/chat/completions", 1)[0] + "/models"
        try:
            response = self._client.get(url, headers=self._headers, timeout=MODEL_LIST_TIMEOUT_S)
        except httpx.HTTPError as exc:
            raise VisionAPIError(f"network error: {exc.__class__.__name__}: {exc}") from None
        if response.status_code != 200:
            raise VisionAPIError(f"HTTP {response.status_code}: {_safe_error_text(response)}")
        try:
            body = response.json()
        except ValueError:
            raise VisionAPIError("The model list was not valid JSON") from None
        entries = body.get("data", []) if isinstance(body, dict) else body
        return [entry for entry in entries if isinstance(entry, dict)] if isinstance(entries, list) else []


# Family tiers for ranking a provider's model list best -> worst for photo analysis:
# flagships first, tiny models later, specialised non-chat models last. Unknown
# (third-party) families sit between the small models and the specialised ones.
_FAMILY_TIERS = [
    ("large", 0),
    ("magistral", 1),
    ("medium", 2),
    ("pixtral", 2),
    ("small", 3),
    ("ministral", 4),
]
_SPECIALISED_TOKENS = ("codestral", "ocr", "embed", "moderation", "voxtral", "transcribe", "tts", "fim")


def _rank_key(model: dict) -> tuple:
    """Sort key ranking one described model against the others (smaller = better)."""
    model_id = model["id"].lower()
    tier, params = 5, 0
    for token, t in _FAMILY_TIERS:
        if token in model_id:
            tier = t
            size = re.search(r"(\d+)b", model_id)
            params = int(size.group(1)) if size else 0
            break
    else:
        if any(token in model_id for token in _SPECIALISED_TOKENS):
            tier = 9
    # Recency within a family: "-latest" wins, then version numbers (3.5 > 3) and date
    # codes (2604 = Apr 2026 > 2512 = Dec 2025). Parameter counts (14b) are not versions.
    recency = 999.0 if "latest" in model_id else 0.0
    if recency < 999.0:
        for number in (int(n) for n in re.findall(r"\d+", model_id)):
            if re.search(rf"{number}b", model_id):
                continue
            if 2000 <= number <= 2999:
                recency = max(recency, (number - 2400) / 100.0)
            elif number < 100:
                recency = max(recency, float(number))
    return tier, -params, model["deprecated"], -recency, model_id


def describe_models(raw: list[dict]) -> list[dict]:
    """Trim a provider's ``/models`` listing to what a model picker needs.

    ``usable`` is False only when the provider says the model cannot chat or cannot read
    images; providers that report no capabilities leave it True (unknown, so not ruled out).
    The list is ranked best -> worst — models that can read photos first, then flagship
    families before small ones, newer versions before older, non-deprecated first — and
    each entry gets a 1-based ``rank``.
    """
    described: dict[str, dict] = {}
    for entry in raw:
        model_id = entry.get("id")
        if not isinstance(model_id, str) or not MODEL_ID.match(model_id) or model_id in described:
            continue
        capabilities = entry.get("capabilities") if isinstance(entry.get("capabilities"), dict) else {}
        chat = capabilities.get("completion_chat") if isinstance(capabilities.get("completion_chat"), bool) else None
        vision = capabilities.get("vision") if isinstance(capabilities.get("vision"), bool) else None
        name = entry.get("name")
        aliases = entry.get("aliases")
        described[model_id] = {
            "id": model_id,
            "name": name if isinstance(name, str) and name != model_id else None,
            "aliases": [a for a in aliases if isinstance(a, str)] if isinstance(aliases, list) else [],
            "chat": chat,
            "vision": vision,
            "usable": chat is not False and vision is not False,
            "deprecated": bool(entry.get("deprecation")),
        }
    ranked = sorted(described.values(), key=lambda m: (not m["usable"], *_rank_key(m)))
    for position, model in enumerate(ranked, start=1):
        model["rank"] = position
    return ranked


def list_available_models(settings: Settings) -> list[dict]:
    """Ask the configured provider which models this API key can use."""
    client = OpenAICompatVisionClient(
        api_key=settings.require_api_key(), model=settings.vision_model, base_url=settings.base_url,
    )
    return describe_models(client.list_models())


def clients_for_run(
    client: VisionClient, settings: Settings, model: str | None = None
) -> tuple[VisionClient, VisionClient | None, str]:
    """``(vision client, reasoning client or None, vision model name)`` for one analysis.

    ``model`` is a per-run choice and is used for every pass; without it the configured
    VISION_MODEL / REASONING_MODEL apply.
    """
    if not isinstance(client, OpenAICompatVisionClient):
        return client, None, "mock"
    vision_model = model or settings.vision_model
    reasoning_model = model or settings.reasoning_model
    if model:
        client = client.with_model(model)
    reasoning = client.with_model(reasoning_model) if reasoning_model != vision_model else None
    return client, reasoning, vision_model


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


_MOCK_DESIGN = {
    "summary": "MOCK DATA: a small 2WD relay-switched rover (canned reply, not derived from your robot).",
    "design_choices": [
        {"issue_id": "drivetrain.unknown", "choice": "2 DC gear motors on the rear wheels; front wheels roll freely",
         "reason": "MOCK DATA: canned choice."},
        {"issue_id": "controller.unknown", "choice": "Arduino Uno R3 as the controller", "reason": "MOCK DATA: canned choice."},
    ],
    "components": [
        {"name": "rubber wheel", "category": "wheel", "quantity": 4, "specs": {"diameter_mm": "65"}, "basis": "observed"},
        {"name": "DC gear motor", "category": "motor", "quantity": 2, "specs": {"voltage_v": "6"}, "basis": "inferred"},
        {"name": "TB6612FNG dual motor driver", "category": "motor_driver", "quantity": 1,
         "specs": {"max_current_a": "1.2"}, "basis": "inferred"},
        {"name": "Arduino Uno R3", "category": "microcontroller", "quantity": 1, "specs": {"logic_level_v": "5"},
         "basis": "inferred"},
    ],
}

_MOCK_SOURCING = {
    "power_budget": "MOCK DATA: 6 V supply, 5 V logic, about 1 A total (canned estimate).",
    "searches": [
        {"component": "rubber wheel", "search_query": "65mm rubber robot wheel TT motor",
         "recommended_sites": ["amazon"], "note": "MOCK DATA: canned suggestion."},
        {"component": "DC gear motor", "search_query": "TT gear motor 6V 1:48",
         "recommended_sites": ["amazon", "sparkfun"], "note": "MOCK DATA: canned suggestion."},
        {"component": "TB6612FNG dual motor driver", "search_query": "TB6612FNG motor driver breakout",
         "recommended_sites": ["sparkfun", "digikey"], "note": "MOCK DATA: canned suggestion."},
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
        # The design step's schemas live in design.py, which imports this module.
        if response_schema.__name__ == "InferredDesign":
            return json.dumps(_MOCK_DESIGN)
        if response_schema.__name__ == "SourcingPlan":
            return json.dumps(_MOCK_SOURCING)
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
