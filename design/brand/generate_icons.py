#!/usr/bin/env python3
"""Derive cross-platform app icon assets for skill-switch.

Source of truth (do NOT modify):
    design/brand/skill-switch-calico-source.png
    1254x1254 RGB PNG, SHA-256 7805d7f36ce6dc356c6fad3091b26e29f9b0a68f88de5042d4db70a924eb49bc

Allowed derivations (per skill-switch issue #66 / parent spec #114):
  - unify to a square canvas (already square)
  - make the WHITE CORNERS outside the cream rounded-square base plate
    transparent on a per-pixel basis; the cream base plate and the cat
    subject (colors, expression, main outline) must NOT change
  - set color profile, scale, and emit target formats
  - high-quality downscaling + light sharpening for tiny sizes only

No re-generation, no blue-tinting, no abstraction, no redrawn graphics.

Algorithm for transparency:
  The source is a cream rounded-square base plate that touches the canvas
  edges on its 4 straight sides, with WHITE rounded corners (~49px radius).
  The cat's white face sits in the center, fully enclosed by non-white
  (cream plate + colored cat features). A flood-fill of "near-white" pixels
  (all channels >= 250) seeded from every canvas-border pixel reaches ONLY
  the four corner regions; the enclosed cat-face white is never reached and
  stays opaque. The alpha boundary therefore traces the cream plate's
  anti-aliased edge, producing clean transparency without altering the plate
  or the cat.

Outputs (under repo root):
  resources/icons/icon.icns       macOS (16/32/64/128/256/512/1024 + @2x)
  resources/icons/icon.ico        Windows (16/32/48/64/128/256)
  resources/icons/icon.png        1024 master PNG (RGBA, transparency)
  resources/icons/icon-1024.png   1024 standalone
  resources/icons/icon-512.png    512  (Linux hi-dpi / repo-grade)
  resources/icons/icon-256.png    256  (Linux main icon)
  design/brand/skill-switch-avatar.png  512 repo avatar

Reproducible: deterministic PIL resampling (LANCZOS) + iconutil. Re-run anytime:
  python3 design/brand/generate_icons.py
"""
from __future__ import annotations

import hashlib
import shutil
import struct
import subprocess
import sys
from collections import deque
from pathlib import Path

from PIL import Image  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC = REPO_ROOT / "design/brand/skill-switch-calico-source.png"
ICON_DIR = REPO_ROOT / "resources/icons"
ICONSET = REPO_ROOT / "build/icon.iconset"  # transient; build/ is gitignored
AVATAR = REPO_ROOT / "design/brand/skill-switch-avatar.png"

EXPECTED_SHA256 = "7805d7f36ce6dc356c6fad3091b26e29f9b0a68f88de5042d4db70a924eb49bc"

# Sizes for standalone PNGs (kept under resources/icons for version control).
PNG_SIZES = (256, 512, 1024)
# macOS iconset entries: (filename, px). @2x variants are the doubled sizes.
MACOS_ICONSET = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]
# Windows ICO embedded PNG sizes.
ICO_SIZES = (16, 32, 48, 64, 128, 256)

# Near-white threshold: source corners measure 253..255 in every channel;
# cream plate is ~ (254, 239, 215) so G/B fall well below this.
NEAR_WHITE_MIN = 250


def die(msg: str) -> None:
    print(f"generate_icons: ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def assert_source_unchanged() -> None:
    h = hashlib.sha256(SRC.read_bytes()).hexdigest()
    if h != EXPECTED_SHA256:
        die(
            f"source image SHA-256 mismatch.\n  expected: {EXPECTED_SHA256}\n  actual:   {h}\n"
            "Refusing to derive from an unverified source."
        )


def build_master_rgba() -> Image.Image:
    """Return the 1254x1254 RGBA master with white corners -> transparent."""
    src = Image.open(SRC).convert("RGB")
    w, h = src.size
    if (w, h) != (1254, 1254):
        die(f"unexpected source size {w}x{h}; expected 1254x1254")
    px = src.load()

    near_white = bytearray(w * h)
    for y in range(h):
        base = y * w
        for x in range(w):
            r, g, b = px[x, y]
            if r >= NEAR_WHITE_MIN and g >= NEAR_WHITE_MIN and b >= NEAR_WHITE_MIN:
                near_white[base + x] = 1

    # Flood fill from every border pixel through near-white pixels only.
    transparent = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            i = y * w + x
            if near_white[i] and not transparent[i]:
                transparent[i] = 1
                q.append(i)
    for y in range(h):
        for x in (0, w - 1):
            i = y * w + x
            if near_white[i] and not transparent[i]:
                transparent[i] = 1
                q.append(i)
    while q:
        i = q.popleft()
        x = i % w
        y = i // w
        if x > 0:
            j = i - 1
            if near_white[j] and not transparent[j]:
                transparent[j] = 1
                q.append(j)
        if x < w - 1:
            j = i + 1
            if near_white[j] and not transparent[j]:
                transparent[j] = 1
                q.append(j)
        if y > 0:
            j = i - w
            if near_white[j] and not transparent[j]:
                transparent[j] = 1
                q.append(j)
        if y < h - 1:
            j = i + w
            if near_white[j] and not transparent[j]:
                transparent[j] = 1
                q.append(j)

    rgba = Image.new("RGBA", (w, h))
    out = rgba.load()
    for y in range(h):
        base = y * w
        for x in range(w):
            r, g, b = px[x, y]
            a = 0 if transparent[base + x] else 255
            out[x, y] = (r, g, b, a)
    return rgba


def resize(master: Image.Image, size: int) -> Image.Image:
    if size >= master.width:
        # Downscale path is the norm; if ever asked to upscale, refuse rather
        # than invent pixels beyond the source.
        if size == master.width:
            return master.copy()
        die(f"refusing to upscale master {master.width} -> {size}")
    im = master.resize((size, size), Image.LANCZOS)
    # Light sharpening for tiny sizes to keep the cat recognizable; no redraw.
    if size <= 64:
        from PIL import ImageFilter
        im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=80, threshold=2))
    return im


def write_png(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, format="PNG", optimize=True)


def build_icns(master: Image.Image) -> Path:
    if shutil.which("iconutil") is None:
        die("iconutil not found; macOS .icns generation requires macOS.")
    if ICONSET.exists():
        shutil.rmtree(ICONSET)
    ICONSET.mkdir(parents=True)
    for name, size in MACOS_ICONSET:
        write_png(resize(master, size), ICONSET / name)
    out = ICON_DIR / "icon.icns"
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    res = subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET), "-o", str(out)],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        die(f"iconutil failed:\n{res.stderr}")
    return out


def write_ico(master: Image.Image, path: Path) -> None:
    """Write a multi-size ICO with PNG-embedded entries (Vista+ compatible)."""
    images = [resize(master, s) for s in ICO_SIZES]
    png_blobs = []
    for im in images:
        from io import BytesIO
        buf = BytesIO()
        im.save(buf, format="PNG", optimize=True)
        png_blobs.append(buf.getvalue())

    count = len(png_blobs)
    header = struct.pack("<HHH", 0, 1, count)  # reserved, type=icon, count
    entries = bytearray()
    data = bytearray()
    offset = 6 + count * 16  # header + directory
    for (size, _), blob in zip(
        [(im.width, im.height) for im in images], png_blobs
    ):
        # Width/height: 0 means 256.
        w = 0 if size == 256 else size
        h = 0 if size == 256 else size
        entries += struct.pack(
            "<BBBBHHII",
            w, h, 0, 0, 1, 32, len(blob), offset,
        )
        data += blob
        offset += len(blob)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + bytes(entries) + bytes(data))
    return path


def main() -> None:
    assert_source_unchanged()
    ICON_DIR.mkdir(parents=True, exist_ok=True)

    master = build_master_rgba()
    write_png(master, ICON_DIR / "icon.png")  # 1254 master kept as canonical RGBA

    manifest = []
    for size in PNG_SIZES:
        p = ICON_DIR / f"icon-{size}.png"
        write_png(resize(master, size), p)
        manifest.append((p, size, size))

    icns = build_icns(master)
    manifest.append((icns, "macOS icns", "16..1024 + @2x"))

    ico = ICON_DIR / "icon.ico"
    write_ico(master, ico)
    manifest.append((ico, "Windows ico", list(ICO_SIZES)))

    write_png(resize(master, 512), AVATAR)
    manifest.append((AVATAR, "repo avatar", 512))

    # Also keep 16/32/64 standalone PNGs so tiny sizes are independently
    # inspectable and the test suite can sample them without parsing ICO/ICNS.
    for size in (16, 32, 64):
        p = ICON_DIR / f"icon-{size}.png"
        write_png(resize(master, size), p)
        manifest.append((p, size, size))

    print("generate_icons: derived assets:")
    relroot = str(REPO_ROOT) + "/"
    for path, kind, size in manifest:
        print(f"  {str(path).replace(relroot, '')}  ({kind}, {size})")
    print("generate_icons: done.")


if __name__ == "__main__":
    main()
