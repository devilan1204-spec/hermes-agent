"""Manual verification that Anthropic's >8000px image rejection is real and
that our dimension clamp unblocks the call.

Not a pytest — a script you run manually when you suspect Anthropic moved the
threshold or the error message changed. Mirrors the pattern in
``scripts/benchmark_browser_eval.py``.

Usage:
    ANTHROPIC_API_KEY=... .venv/bin/python scripts/verify_anthropic_pixel_cap.py
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
from io import BytesIO
from pathlib import Path


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY not set", file=sys.stderr)
        return 2

    # Make tools/ importable
    repo_root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(repo_root))

    from PIL import Image
    import anthropic
    from tools.vision_tools import _MAX_IMAGE_DIMENSION, _resize_image_for_vision

    model = "claude-haiku-4-5-20251001"
    client = anthropic.Anthropic()

    with tempfile.TemporaryDirectory() as td:
        raw_path = Path(td) / "oversize.png"
        Image.new("RGB", (8500, 100), (128, 128, 128)).save(raw_path, "PNG")
        raw_b64 = base64.b64encode(raw_path.read_bytes()).decode()

        # Step 1: confirm Anthropic still rejects raw oversized image.
        print(f"[1/2] Sending raw 8500x100 PNG to {model}...")
        try:
            client.messages.create(
                model=model, max_tokens=64,
                messages=[{"role": "user", "content": [
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": raw_b64,
                    }},
                    {"type": "text", "text": "describe"},
                ]}],
            )
            print("  UNEXPECTED: raw oversized image was accepted. "
                  "Anthropic may have relaxed the cap — investigate.")
            return 1
        except anthropic.BadRequestError as exc:
            msg = str(exc).lower()
            if "8000" in msg or "dimensions" in msg:
                print(f"  OK rejected as expected: {exc}")
            else:
                print(f"  WARN unexpected error shape: {exc}")
                print("  _is_image_size_error may need a refresh.")
                return 1

        # Step 2: confirm clamped image is accepted.
        print(f"[2/2] Clamping + retrying...")
        data_url = _resize_image_for_vision(raw_path, mime_type="image/png",
                                            clamp_dimensions=True)
        _, clamped_b64 = data_url.split(",", 1)
        decoded = Image.open(BytesIO(base64.b64decode(clamped_b64)))
        print(f"  Clamped to {decoded.width}x{decoded.height} "
              f"(cap={_MAX_IMAGE_DIMENSION})")
        resp = client.messages.create(
            model=model, max_tokens=64,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {
                    "type": "base64", "media_type": "image/png", "data": clamped_b64,
                }},
                {"type": "text", "text": "describe"},
            ]}],
        )
        if not resp.content:
            print("  FAIL: clamped image accepted but response empty")
            return 1
        print(f"  OK clamped image accepted")

    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
