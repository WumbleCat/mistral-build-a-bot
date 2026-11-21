"""Stage A - image ingestion and preprocessing."""

from __future__ import annotations

import hashlib
import io
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

log = logging.getLogger(__name__)

MAX_EDGE_PX = 1600
MAX_INPUT_BYTES = 40 * 1024 * 1024


class IngestError(ValueError):
    """Raised when an input image cannot be used."""


@dataclass(frozen=True)
class ImageInput:
    image_id: str
    filename: str
    mime_type: str
    data: bytes = field(repr=False)  # preprocessed JPEG bytes sent to the API
    sha256: str  # hash of the ORIGINAL file, for the audit trail
    width: int
    height: int


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "image"


def preprocess(raw: bytes, filename: str, image_id: str) -> ImageInput:
    """Validate, EXIF-rotate, downscale and re-encode one image as JPEG."""
    if not raw:
        raise IngestError(f"{filename}: file is empty")
    if len(raw) > MAX_INPUT_BYTES:
        raise IngestError(f"{filename}: file is larger than {MAX_INPUT_BYTES // (1024 * 1024)} MB")
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode not in ("RGB", "L"):
                # Flatten transparency onto white so parts stay visible.
                rgba = img.convert("RGBA")
                background = Image.new("RGB", rgba.size, (255, 255, 255))
                background.paste(rgba, mask=rgba.split()[-1])
                img = background
            else:
                img = img.convert("RGB")
            img.thumbnail((MAX_EDGE_PX, MAX_EDGE_PX))
            buffer = io.BytesIO()
            img.save(buffer, format="JPEG", quality=90)
            width, height = img.size
    except (UnidentifiedImageError, OSError) as exc:
        raise IngestError(f"{filename}: not a readable image ({exc.__class__.__name__})") from None

    return ImageInput(
        image_id=image_id,
        filename=filename,
        mime_type="image/jpeg",
        data=buffer.getvalue(),
        sha256=hashlib.sha256(raw).hexdigest(),
        width=width,
        height=height,
    )


def ingest(named_blobs: list[tuple[str, bytes]]) -> list[ImageInput]:
    """Turn ``(filename, bytes)`` pairs into uniquely identified images.

    Byte-identical duplicates are dropped: the same photo submitted twice must not
    look like two independent pieces of evidence.
    """
    if not named_blobs:
        raise IngestError("at least one image is required")

    images: list[ImageInput] = []
    seen_hashes: dict[str, str] = {}
    used_ids: set[str] = set()
    for index, (filename, raw) in enumerate(named_blobs, start=1):
        digest = hashlib.sha256(raw).hexdigest()
        if digest in seen_hashes:
            log.warning("%s is byte-identical to %s; skipping duplicate", filename, seen_hashes[digest])
            continue
        base = f"img{index}-{_slug(Path(filename).stem)}"
        image_id, suffix = base, 2
        while image_id in used_ids:
            image_id, suffix = f"{base}-{suffix}", suffix + 1
        used_ids.add(image_id)
        seen_hashes[digest] = filename
        images.append(preprocess(raw, filename, image_id))
    return images


def load_images(paths: list[str | Path]) -> list[ImageInput]:
    blobs: list[tuple[str, bytes]] = []
    for path in paths:
        p = Path(path)
        if not p.is_file():
            raise IngestError(f"image not found: {p}")
        blobs.append((p.name, p.read_bytes()))
    return ingest(blobs)
