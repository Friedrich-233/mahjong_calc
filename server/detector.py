import base64
import io
import json
import sys

from mahjong_detector import detect_tiles


TILE_MAP = {
    "chun": "7z",
    "haku": "5z",
    "hatsu": "6z",
    "nan": "2z",
    "pe": "4z",
    "sha": "3z",
    "tou": "1z",
}


def decode_image(value: str) -> bytes:
    if value.startswith("data:"):
        _, value = value.split(",", 1)
    return base64.b64decode(value)


def to_mpsz(tile_name: str) -> str | None:
    normalized = tile_name.strip().lower()
    if normalized in TILE_MAP:
        return TILE_MAP[normalized]
    if len(normalized) == 2 and normalized[0].isdigit() and normalized[1] in "mps":
        return normalized
    return None


def main() -> int:
    payload = json.load(sys.stdin)
    image = payload.get("image")
    if not isinstance(image, str) or not image:
        print(json.dumps({"error": "No image provided."}), file=sys.stderr)
        return 2

    detected = detect_tiles(io.BytesIO(decode_image(image)))
    tiles = [tile for tile in (to_mpsz(item) for item in detected) if tile is not None]
    winning_tile = tiles[-1] if tiles else None

    print(
        json.dumps(
            {
                "concealed": "".join(tiles[:-1] if winning_tile else tiles),
                "melds": [],
                "winning_tile": winning_tile,
                "aka": [],
                "detector": {
                    "name": "mahjong-detector",
                    "raw_tiles": detected,
                    "tiles": tiles,
                },
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
