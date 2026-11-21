"""Runtime configuration, read from environment variables / ``.env``.

The API key is never logged, printed, or included in ``repr``.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

DEFAULT_BASE_URL = "https://api.mistral.ai/v1"
DEFAULT_MODEL = "mistral-large-latest"
# Seconds to wait for one model reply. A large vision model writing a full parts list for a
# photo has been seen to take longer than two minutes, so the limit is generous.
DEFAULT_TIMEOUT_S = 300.0

_TRUTHY = {"1", "true", "yes", "on"}


class ConfigError(RuntimeError):
    """Raised when the app cannot run with the current configuration."""


@dataclass(frozen=True)
class Settings:
    api_key: str | None = field(default=None, repr=False)
    base_url: str = DEFAULT_BASE_URL
    vision_model: str = DEFAULT_MODEL
    reasoning_model: str = DEFAULT_MODEL
    json_mode: str = "json_object"  # json_object | none
    timeout_s: float = DEFAULT_TIMEOUT_S
    max_retries: int = 2  # extra attempts after a malformed model response
    mock: bool = False
    verify: bool = True  # visibility re-check after pass 1
    grounding: bool = False  # local Grounding DINO + SAM 2 stage; off = VLM/LLM only
    dino_model: str = "IDEA-Research/grounding-dino-tiny"
    sam_model: str = "facebook/sam2.1-hiera-tiny"
    box_threshold: float = 0.25
    text_threshold: float = 0.20
    catalog_api_url: str | None = None
    catalog_api_key: str | None = field(default=None, repr=False)

    @property
    def has_api_key(self) -> bool:
        return bool(self.api_key)

    def require_api_key(self) -> str:
        if not self.api_key:
            raise ConfigError(
                "No vision API key is configured. Set MISTRAL_API_KEY (or VISION_API_KEY) in "
                "your environment or .env file, or run with --mock for offline mock mode."
            )
        return self.api_key


def load_settings(env: Mapping[str, str] | None = None, *, dotenv: bool = True) -> Settings:
    """Build settings from ``env`` (defaults to the process environment).

    ``VISION_*`` variables take precedence; ``MISTRAL_API_KEY`` / ``MISTRAL_MODEL`` are the
    fallbacks so an existing Mistral setup works unchanged.
    """
    if env is None:
        if dotenv:
            from dotenv import find_dotenv, load_dotenv

            load_dotenv(find_dotenv(usecwd=True))
        env = os.environ

    def get(name: str) -> str | None:
        value = env.get(name)
        return value.strip() if value and value.strip() else None

    model = get("VISION_MODEL") or get("MISTRAL_MODEL") or DEFAULT_MODEL
    json_mode = (get("VISION_JSON_MODE") or "json_object").lower()
    if json_mode not in {"json_object", "none"}:
        raise ConfigError("VISION_JSON_MODE must be 'json_object' or 'none'")
    try:
        timeout_s = float(get("VISION_TIMEOUT_S") or DEFAULT_TIMEOUT_S)
        max_retries = int(get("VISION_MAX_RETRIES") or 2)
        box_threshold = float(get("GROUNDING_BOX_THRESHOLD") or 0.25)
        text_threshold = float(get("GROUNDING_TEXT_THRESHOLD") or 0.20)
    except ValueError as exc:
        raise ConfigError(f"Invalid numeric setting: {exc}") from None
    if timeout_s <= 0:
        raise ConfigError("VISION_TIMEOUT_S must be greater than 0")

    return Settings(
        api_key=get("VISION_API_KEY") or get("MISTRAL_API_KEY"),
        base_url=(get("VISION_API_BASE_URL") or DEFAULT_BASE_URL).rstrip("/"),
        vision_model=model,
        reasoning_model=get("REASONING_MODEL") or model,
        json_mode=json_mode,
        timeout_s=timeout_s,
        max_retries=max(0, max_retries),
        mock=(get("ROBOT_BOM_MOCK") or "").lower() in _TRUTHY,
        verify=(get("VISION_VERIFY") or "1").lower() in _TRUTHY,
        grounding=(get("ROBOT_BOM_GROUNDING") or "").lower() in _TRUTHY,
        dino_model=get("GROUNDING_DINO_MODEL") or "IDEA-Research/grounding-dino-tiny",
        sam_model=get("GROUNDING_SAM_MODEL") or "facebook/sam2.1-hiera-tiny",
        box_threshold=box_threshold,
        text_threshold=text_threshold,
        catalog_api_url=get("CATALOG_API_URL"),
        catalog_api_key=get("CATALOG_API_KEY"),
    )
