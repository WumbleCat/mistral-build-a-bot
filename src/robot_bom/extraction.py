"""Stage B - vision API extraction with schema validation and bounded retries."""

from __future__ import annotations

import json
import logging
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from .ingest import ImageInput
from .models import Component, ImageObservation, InferenceAudit, UnconfirmedPart, VisibilityAudit
from .prompts import (
    PASS1_SYSTEM, PASS2_SYSTEM, VERIFY_SYSTEM, pass1_user_prompt, pass2_user_prompt,
    verify_user_prompt,
)
from .vision import VisionAPIError, VisionClient

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class VisionResponseError(RuntimeError):
    """The model never produced a schema-valid reply within the retry budget."""

    def __init__(self, stage: str, attempts: int, errors: list[str]) -> None:
        self.stage = stage
        self.attempts = attempts
        self.errors = errors
        super().__init__(
            f"{stage}: the vision API did not return schema-valid JSON after {attempts} "
            f"attempt(s). Last validation errors: {'; '.join(errors[:5])}. "
            "No BOM was produced from this response."
        )


def _extract_json(text: str) -> object:
    """Parse a JSON document, tolerating code fences or stray prose around it."""
    stripped = text.strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    start, end = stripped.find("{"), stripped.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("reply contains no JSON object")
    try:
        return json.loads(stripped[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"reply is not valid JSON ({exc.msg} at char {exc.pos})") from None


def _summarise(exc: ValidationError) -> list[str]:
    return [
        f"{'.'.join(str(part) for part in err['loc']) or '<root>'}: {err['msg']}"
        for err in exc.errors()[:8]
    ]


def call_structured(
    client: VisionClient,
    images: list[ImageInput],
    system_prompt: str,
    user_prompt: str,
    schema: type[T],
    *,
    stage: str,
    max_retries: int = 2,
) -> T:
    """Call the model and validate the reply; on failure, retry with the errors fed back."""
    attempts = max_retries + 1
    prompt = user_prompt
    errors: list[str] = []
    for attempt in range(1, attempts + 1):
        raw = client.analyze(images, system_prompt, schema, prompt)
        try:
            data = _extract_json(raw)
            if not isinstance(data, dict):
                raise ValueError("top-level JSON value must be an object")
            return schema.model_validate(data)
        except ValidationError as exc:
            errors = _summarise(exc)
        except ValueError as exc:
            errors = [str(exc)]
        # Validation messages describe structure only; they never contain credentials.
        log.warning("%s: attempt %d/%d rejected: %s", stage, attempt, attempts, "; ".join(errors))
        prompt = (
            f"{user_prompt}\n\nYour previous reply was rejected for these reasons:\n"
            + "\n".join(f"- {e}" for e in errors)
            + "\nReturn a corrected JSON object only."
        )
    raise VisionResponseError(stage, attempts, errors)


def verify_observation(
    client: VisionClient, image: ImageInput, observation: ImageObservation, *, max_retries: int = 2
) -> None:
    """Re-check each pass-1 claim against the image; move unconfirmed ones aside.

    Vision models sometimes list parts that are implied rather than seen (four wheels ->
    "four motors"). A claim that fails this check is no longer an observation.
    """
    if not observation.parts:
        observation.verification = "ok"
        return
    claims = [
        {"index": i, "category": p.category, "name": p.name,
         "claimed_quantity": p.visible_quantity, "claimed_description": p.description}
        for i, p in enumerate(observation.parts)
    ]
    try:
        audit = call_structured(
            client, [image], VERIFY_SYSTEM, verify_user_prompt(image.image_id, claims),
            VisibilityAudit, stage=f"visibility re-check ({image.image_id})", max_retries=max_retries,
        )
    except (VisionResponseError, VisionAPIError) as exc:
        log.warning("visibility re-check unavailable for %s: %s", image.image_id, exc)
        observation.verification = "failed"
        return
    rejected = {c.index: c.reason for c in audit.checks if not c.directly_visible}
    kept = []
    for index, part in enumerate(observation.parts):
        if index in rejected:
            observation.unconfirmed.append(
                UnconfirmedPart(category=part.category, name=part.name,
                                reason=rejected[index] or "not confirmed as directly visible")
            )
        else:
            kept.append(part)
    observation.parts = kept
    observation.verification = "ok"


def extract_observations(
    client: VisionClient, images: list[ImageInput], *, max_retries: int = 2, verify: bool = True
) -> list[ImageObservation]:
    """Pass 1 - observed-only extraction, one structured result per image."""
    observations: list[ImageObservation] = []
    known: list[tuple[str, str]] = []
    for image in images:
        observation = call_structured(
            client,
            [image],
            PASS1_SYSTEM,
            pass1_user_prompt(image.image_id, known),
            ImageObservation,
            stage=f"pass 1 (observed parts, {image.image_id})",
            max_retries=max_retries,
        )
        observation.image_id = image.image_id  # authoritative id comes from ingestion
        observation.unconfirmed, observation.verification = [], "not_run"  # never model-supplied
        if verify:
            verify_observation(client, image, observation, max_retries=max_retries)
        observations.append(observation)
        for part in observation.parts:
            pair = (part.category, part.name)
            if pair not in known:
                known.append(pair)
    return observations


def run_inference_audit(
    client: VisionClient,
    components: list[Component],
    observations: list[ImageObservation],
    *,
    max_retries: int = 2,
) -> InferenceAudit:
    """Pass 2 - text-only completeness audit over the reconciled observed inventory."""
    inventory = [
        {
            "id": c.id,
            "category": c.category,
            "name": c.name,
            "visible_quantity": c.visible_quantity,
            "evidence": [f"{e.image_id}: {e.description}" for e in c.evidence],
            "visible_markings": c.specs.get("visible_markings"),
        }
        for c in components
    ]
    views = [{"image_id": o.image_id, "view": o.view or "unknown"} for o in observations]
    return call_structured(
        client,
        [],
        PASS2_SYSTEM,
        pass2_user_prompt(inventory, views),
        InferenceAudit,
        stage="pass 2 (inference audit)",
        max_retries=max_retries,
    )
