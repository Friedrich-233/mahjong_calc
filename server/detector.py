import base64
import io
import json
import os
import sys
from typing import Any

from PIL import Image

from mahjong_detector import detect_tiles
from mahjong_detector.predict import CLASS_NAMES, predict
from mahjong_detector.preprocess import preprocess_image


DETECTOR_TILE_MAP = {
    "chun": "7z",
    "haku": "5z",
    "hatsu": "6z",
    "nan": "2z",
    "pe": "4z",
    "sha": "3z",
    "tou": "1z",
}

HF_TILE_MAP = {
    "ew": "1z",
    "sw": "2z",
    "ww": "3z",
    "nw": "4z",
    "wd": "5z",
    "gd": "6z",
    "rd": "7z",
}

HF_MODEL_ID = os.environ.get("DETECTOR_HF_MODEL", "krmin/mahjong_vision")
HF_SUBFOLDER = os.environ.get("DETECTOR_HF_SUBFOLDER", "vision_transformer_local")
CLASSIFIER_MODE = os.environ.get("DETECTOR_CLASSIFIER", "hf").lower()

_hf_processor = None
_hf_model = None


def decode_image(value: str) -> bytes:
    if value.startswith("data:"):
        _, value = value.split(",", 1)
    return base64.b64decode(value)


def detector_to_mpsz(tile_name: str) -> str | None:
    normalized = tile_name.strip().lower()
    if normalized in DETECTOR_TILE_MAP:
        return DETECTOR_TILE_MAP[normalized]
    if len(normalized) == 2 and normalized[0].isdigit() and normalized[1] in "mps":
        return normalized
    return None


def hf_to_mpsz(label: str) -> str | None:
    normalized = label.strip().lower()
    if normalized in HF_TILE_MAP:
        return HF_TILE_MAP[normalized]
    if len(normalized) == 2 and normalized[0].isdigit():
        if normalized[1] == "n":
            return f"{normalized[0]}m"
        if normalized[1] == "p":
            return normalized
        if normalized[1] == "b":
            return f"{normalized[0]}s"
    return detector_to_mpsz(normalized)


def result_from_tiles(tiles: list[str], detector: dict[str, Any]) -> dict[str, Any]:
    winning_tile = tiles[-1] if tiles else None
    return {
        "concealed": "".join(tiles[:-1] if winning_tile else tiles),
        "melds": [],
        "winning_tile": winning_tile,
        "aka": [],
        "detector": detector | {"tiles": tiles},
    }


def get_hf_model():
    global _hf_processor, _hf_model
    if _hf_processor is None or _hf_model is None:
        import torch
        from transformers import AutoImageProcessor, AutoModelForImageClassification

        _hf_processor = AutoImageProcessor.from_pretrained(
            HF_MODEL_ID, subfolder=HF_SUBFOLDER
        )
        _hf_model = AutoModelForImageClassification.from_pretrained(
            HF_MODEL_ID, subfolder=HF_SUBFOLDER
        )
        _hf_model.eval()
        torch.set_num_threads(max(1, int(os.environ.get("TORCH_NUM_THREADS", "2"))))
    return _hf_processor, _hf_model


def classify_crop(crop: Image.Image) -> dict[str, Any]:
    import torch

    processor, model = get_hf_model()
    inputs = processor(images=crop.convert("RGB"), return_tensors="pt")
    with torch.no_grad():
        logits = model(**inputs).logits[0]
        probs = torch.nn.functional.softmax(logits, dim=-1)
        values, indices = torch.topk(probs, k=min(5, probs.shape[-1]))
    top = []
    for value, index in zip(values.tolist(), indices.tolist()):
        label = model.config.id2label[int(index)]
        top.append(
            {
                "label": label,
                "tile": hf_to_mpsz(label),
                "confidence": float(value),
            }
        )
    return top[0] | {"top": top}


def expand_box(
    box: tuple[int, int, int, int], width: int, height: int, ratio: float = 0.08
) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    dx = int((x2 - x1) * ratio)
    dy = int((y2 - y1) * ratio)
    return (
        max(0, x1 - dx),
        max(0, y1 - dy),
        min(width, x2 + dx),
        min(height, y2 + dy),
    )


def recognize_with_hf(img: Image.Image) -> dict[str, Any]:
    processed, padding_info = preprocess_image(img)
    detections = predict(processed, padding_info)
    detections.sort(key=lambda d: (d.x1, d.y1))

    raw = []
    tiles = []
    for detection in detections:
        box = expand_box(
            (detection.x1, detection.y1, detection.x2, detection.y2),
            img.width,
            img.height,
        )
        crop = img.crop(box)
        classified = classify_crop(crop)
        tile = classified.get("tile")
        if isinstance(tile, str):
            tiles.append(tile)
        raw.append(
            {
                "box": box,
                "detector_label": CLASS_NAMES[detection.class_id],
                "detector_confidence": detection.confidence,
                "classifier": classified,
            }
        )

    return result_from_tiles(
        tiles,
        {
            "name": "mahjong-detector+krmin/mahjong_vision",
            "classifier": HF_MODEL_ID,
            "subfolder": HF_SUBFOLDER,
            "raw": raw,
        },
    )


def recognize_with_detector_only(img_bytes: bytes) -> dict[str, Any]:
    detected = detect_tiles(io.BytesIO(img_bytes))
    tiles = [tile for tile in (detector_to_mpsz(item) for item in detected) if tile]
    return result_from_tiles(
        tiles,
        {
            "name": "mahjong-detector",
            "raw_tiles": detected,
        },
    )


def main() -> int:
    payload = json.load(sys.stdin)
    image = payload.get("image")
    if not isinstance(image, str) or not image:
        print(json.dumps({"error": "No image provided."}), file=sys.stderr)
        return 2

    img_bytes = decode_image(image)
    if CLASSIFIER_MODE == "hf":
        result = recognize_with_hf(Image.open(io.BytesIO(img_bytes)).convert("RGB"))
    else:
        result = recognize_with_detector_only(img_bytes)

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
