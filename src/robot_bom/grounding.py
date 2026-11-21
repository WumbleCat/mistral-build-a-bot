"""Optional stage - local part localisation with Grounding DINO + SAM 2.

This stage is OFF by default: the app then runs on the vision/language model alone.
When switched on, the parts the vision model listed are located on the photo by a
text-conditioned detector (Grounding DINO) and outlined by a segmenter (SAM 2).

What it does and does not do:

* It only *locates* parts the vision model already observed. A detector hit never
  creates a BOM line, a count, or a specification.
* Detector / mask scores are not calibrated probabilities that a part is identified
  correctly; they are reported as-is and labelled as such.
* It needs ``torch``, ``transformers`` and (for masks) ``sam2``. Those are heavy and are
  not installed by default - see README.
"""

from __future__ import annotations

import importlib.util
import io
import logging
import os
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .config import ConfigError, Settings
from .ingest import ImageInput
from .models import ImageObservation, PartDetection
from .taxonomy import name_tokens

log = logging.getLogger(__name__)

MAX_DETECTIONS_PER_PART = 8
# Same colours, in the same order, as the web page uses for a component's outline.
PALETTE = [(242, 92, 5), (43, 127, 255), (18, 161, 94), (192, 38, 211), (224, 168, 0),
           (10, 165, 181), (229, 72, 77), (124, 92, 255)]

Box = tuple[float, float, float, float]
Colour = tuple[int, int, int]
# Draws the photo with a coloured mask for each given region and returns JPEG bytes.
OverlayRenderer = Callable[[list[tuple[Box, Colour]]], bytes]
INSTALL_HINT = (
    'uv pip install torch torchvision "transformers==4.51.3" huggingface_hub truststore numpy '
    "&& uv pip install git+https://github.com/facebookresearch/sam2.git"
)


@dataclass(frozen=True)
class Detection:
    label: str  # the phrase the detector matched
    bbox_xyxy_norm: tuple[float, float, float, float]
    score: float
    mask_score: float | None = None


@dataclass
class GroundingResult:
    detections: list[Detection] = field(default_factory=list)
    # Present when segmentation masks exist. Called later with only the regions that were
    # matched to listed parts, so unmatched detector hits are never drawn.
    render_overlay: OverlayRenderer | None = None


class Grounder(Protocol):
    name: str

    def locate(self, image: ImageInput, phrases: list[str]) -> GroundingResult:
        """Find regions matching the given short noun phrases."""
        ...


def grounding_available() -> bool:
    """True when the libraries needed for Grounding DINO are importable."""
    return all(importlib.util.find_spec(module) is not None for module in ("torch", "transformers", "numpy"))


def sam_available() -> bool:
    return importlib.util.find_spec("sam2") is not None


def phrase_for(name: str) -> str:
    """Short detector prompt for a part name: no brackets, at most the last three words."""
    cleaned = re.sub(r"\([^)]*\)", " ", name.lower())
    words = re.findall(r"[a-z0-9][a-z0-9-]*", cleaned)
    return " ".join(words[-3:])


def _iou(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def assign_detections(part_names: list[str], detections: list[Detection]) -> dict[int, list[Detection]]:
    """Map detector hits back to the listed parts by shared words.

    A hit whose label shares no clear majority of words with any listed part is dropped:
    the detector is not allowed to introduce parts of its own.
    """
    part_tokens = [name_tokens(phrase_for(name)) for name in part_names]
    assigned: dict[int, list[Detection]] = {}
    for detection in sorted(detections, key=lambda d: d.score, reverse=True):
        label = name_tokens(detection.label)
        if not label:
            continue
        # Rank parts by how much of the label they explain ("wheel" -> "rubber wheel").
        # A label that fits two listed parts equally well is ambiguous and is dropped.
        ranked = sorted(
            ((len(label & tokens) / len(label), index)
             for index, tokens in enumerate(part_tokens) if label & tokens),
            reverse=True,
        )
        if not ranked or ranked[0][0] < 0.5:
            continue
        if len(ranked) > 1 and ranked[1][0] == ranked[0][0]:
            continue  # e.g. "module" when both a relay module and a PCB module are listed
        best_index = ranked[0][1]
        kept = assigned.setdefault(best_index, [])
        if len(kept) >= MAX_DETECTIONS_PER_PART:
            continue
        if any(_iou(detection.bbox_xyxy_norm, other.bbox_xyxy_norm) > 0.8 for other in kept):
            continue  # same region reported twice
        kept.append(detection)
    return assigned


def ground_observations(
    grounder: Grounder, images: list[ImageInput], observations: list[ImageObservation]
) -> tuple[dict[str, OverlayRenderer], list[str]]:
    """Attach detector boxes to the observed parts of each image.

    Returns ``(mask renderers by image id, ids of images where grounding failed)``. A
    failure leaves that image's observations exactly as the vision model produced them.
    """
    overlays: dict[str, OverlayRenderer] = {}
    failed: list[str] = []
    by_id = {image.image_id: image for image in images}
    for observation in observations:
        image = by_id.get(observation.image_id)
        if image is None or not observation.parts:
            continue
        names = [part.name for part in observation.parts]
        phrases = list(dict.fromkeys(p for p in (phrase_for(name) for name in names) if p))
        try:
            result = grounder.locate(image, phrases)
        except Exception as exc:  # local model failure must not sink the analysis
            log.warning("grounding failed for %s: %s: %s", image.image_id, exc.__class__.__name__, exc)
            failed.append(image.image_id)
            continue
        for index, hits in assign_detections(names, result.detections).items():
            observation.parts[index].detections = [
                PartDetection(bbox_xyxy_norm=hit.bbox_xyxy_norm, score=hit.score, mask_score=hit.mask_score)
                for hit in hits
            ]
        if result.render_overlay is not None:
            overlays[image.image_id] = result.render_overlay
    return overlays, failed


def render_overlays(renderers: dict[str, OverlayRenderer], components: list) -> dict[str, bytes]:
    """Mask image per photo, one colour per component (matching the web page's outlines)."""
    rendered: dict[str, bytes] = {}
    for image_id, renderer in renderers.items():
        regions = [
            (evidence.bbox_xyxy_norm, PALETTE[index % len(PALETTE)])
            for index, component in enumerate(components)
            for evidence in component.evidence
            if evidence.source == "grounding_dino" and evidence.image_id == image_id and evidence.bbox_xyxy_norm
        ]
        if not regions:
            continue
        try:
            rendered[image_id] = renderer(regions)
        except Exception as exc:  # a drawing problem must not sink the analysis
            log.warning("could not render mask overlay for %s: %s", image_id, exc)
    return rendered


# --------------------------------------------------------------------------
# Real implementation
# --------------------------------------------------------------------------

def _box_key(box: Box) -> tuple[float, ...]:
    return tuple(round(v, 6) for v in box)


def _default_hf_home() -> str | None:
    """Use a project-local ``.hf-cache`` (as the test-mistral notebook does) when one exists."""
    for directory in [Path.cwd(), *Path.cwd().parents]:
        candidate = directory / ".hf-cache"
        if candidate.is_dir():
            return str(candidate)
    return None


class DinoSamGrounder:
    """Grounding DINO boxes, optionally refined into SAM 2 masks. Models load on first use."""

    def __init__(
        self,
        dino_model: str = "IDEA-Research/grounding-dino-tiny",
        sam_model: str = "facebook/sam2.1-hiera-tiny",
        *,
        box_threshold: float = 0.25,
        text_threshold: float = 0.20,
        use_sam: bool = True,
    ) -> None:
        self._dino_model, self._sam_model = dino_model, sam_model
        self._box_threshold, self._text_threshold = box_threshold, text_threshold
        self._use_sam = use_sam and sam_available()
        self._lock = threading.Lock()
        self._loaded = False
        self.name = dino_model.split("/")[-1] + (" + " + sam_model.split("/")[-1] if self._use_sam else "")

    def _load(self) -> None:
        if self._loaded:
            return
        if "HF_HOME" not in os.environ and (home := _default_hf_home()):
            os.environ["HF_HOME"] = home  # must be set before huggingface_hub is imported
        try:  # verify weight downloads against the OS trust store (antivirus / corporate TLS)
            import truststore

            truststore.inject_into_ssl()
        except ImportError:
            pass
        import torch
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        self._torch = torch
        self._device = "cuda" if torch.cuda.is_available() else "cpu"
        log.info("loading %s on %s", self._dino_model, self._device)
        self._processor = AutoProcessor.from_pretrained(self._dino_model)
        self._detector = AutoModelForZeroShotObjectDetection.from_pretrained(self._dino_model).to(self._device).eval()
        self._predictor = None
        if self._use_sam:
            from sam2.sam2_image_predictor import SAM2ImagePredictor

            log.info("loading %s on %s", self._sam_model, self._device)
            self._predictor = SAM2ImagePredictor.from_pretrained(self._sam_model, device=self._device)
        self._loaded = True

    def locate(self, image: ImageInput, phrases: list[str]) -> GroundingResult:
        if not phrases:
            return GroundingResult()
        with self._lock:  # one inference at a time; the models are not thread-safe
            self._load()
            return self._locate(image, phrases)

    def _locate(self, image: ImageInput, phrases: list[str]) -> GroundingResult:
        import numpy as np
        from PIL import Image

        torch = self._torch
        picture = Image.open(io.BytesIO(image.data)).convert("RGB")
        width, height = picture.size
        prompt = ". ".join(phrases) + "."
        inputs = self._processor(images=picture, text=prompt, return_tensors="pt").to(self._device)
        with torch.inference_mode():
            outputs = self._detector(**inputs)
        post = self._processor.post_process_grounded_object_detection
        try:
            processed = post(outputs, inputs.input_ids, box_threshold=self._box_threshold,
                             text_threshold=self._text_threshold, target_sizes=[(height, width)])[0]
        except TypeError:  # newer transformers renamed the argument
            processed = post(outputs, inputs.input_ids, threshold=self._box_threshold,
                             text_threshold=self._text_threshold, target_sizes=[(height, width)])[0]
        labels = processed.get("text_labels", processed.get("labels", []))

        boxes_px: list[list[float]] = []
        found: list[tuple[str, float]] = []
        for box, score, label in zip(processed["boxes"], processed["scores"], labels):
            x1, y1, x2, y2 = (float(v) for v in box.detach().cpu().tolist())
            x1, y1, x2, y2 = max(0.0, x1), max(0.0, y1), min(float(width), x2), min(float(height), y2)
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            boxes_px.append([x1, y1, x2, y2])
            found.append((str(label), float(score.detach().cpu())))

        boxes_norm: list[Box] = [(x1 / width, y1 / height, x2 / width, y2 / height) for x1, y1, x2, y2 in boxes_px]
        mask_scores: list[float | None] = [None] * len(boxes_px)
        render: OverlayRenderer | None = None
        if self._predictor is not None and boxes_px:
            pixels = np.array(picture)
            with torch.inference_mode():
                self._predictor.set_image(pixels)
                masks, scores, _ = self._predictor.predict(
                    box=np.array(boxes_px, dtype=np.float32), multimask_output=False
                )
            masks = np.asarray(masks).reshape(-1, height, width).astype(bool)
            mask_scores = [float(s) for s in np.asarray(scores).reshape(-1)]
            mask_of = {_box_key(box): masks[index] for index, box in enumerate(boxes_norm)}

            def render(regions: list[tuple[Box, Colour]]) -> bytes:
                blended = pixels.astype(np.float32)
                chosen = [(mask_of[_box_key(box)], colour) for box, colour in regions if _box_key(box) in mask_of]
                # paint large regions first so small parts stay visible on top
                for mask, colour in sorted(chosen, key=lambda item: -int(item[0].sum())):
                    blended[mask] = 0.5 * blended[mask] + 0.5 * np.array(colour, dtype=np.float32)
                buffer = io.BytesIO()
                Image.fromarray(blended.astype(np.uint8)).save(buffer, format="JPEG", quality=88)
                return buffer.getvalue()

        detections = [
            Detection(label=label, bbox_xyxy_norm=box, score=score, mask_score=mask_score)
            for (label, score), box, mask_score in zip(found, boxes_norm, mask_scores)
        ]
        return GroundingResult(detections=detections, render_overlay=render)


_SHARED: dict[tuple, DinoSamGrounder] = {}


def build_grounder(settings: Settings) -> Grounder:
    """Return the (process-wide, lazily loaded) local grounder, or explain what is missing."""
    if not grounding_available():
        raise ConfigError(
            "Grounding DINO + SAM 2 mode needs torch and transformers, which are not installed. "
            f"Install them with: {INSTALL_HINT}  - or use the VLM-only mode."
        )
    key = (settings.dino_model, settings.sam_model, settings.box_threshold, settings.text_threshold)
    if key not in _SHARED:
        _SHARED[key] = DinoSamGrounder(
            settings.dino_model, settings.sam_model,
            box_threshold=settings.box_threshold, text_threshold=settings.text_threshold,
        )
    return _SHARED[key]
