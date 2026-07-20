# skill-switch app icon — provenance and derivation rules

This directory holds the authoritative application icon source for skill-switch
and the reproducible derivation pipeline that produces cross-platform icon assets.

## Authoritative source

`skill-switch-calico-source.png`

- A 1254×1254 RGB PNG (no alpha channel) of a calico cat on a cream rounded-square
  base plate, with white canvas corners outside the plate.
- Saved to the collaboration baseline `codex/v1-base` at commit `b4bd5e2`.
- **SHA-256:** `7805d7f36ce6dc356c6fad3091b26e29f9b0a68f88de5042d4db70a924eb49bc`
- Pinned in issue [#66](https://github.com/xijuangu/skill-switch/issues/66) and the
  parent spec [#114](https://github.com/xijuangu/skill-switch/issues/114).

This file MUST NOT be modified. All platform assets are derived from it by
`generate_icons.py`, which refuses to run if the source SHA-256 changes.

## Allowed derivations

Per the #114 parent spec, derivations may ONLY perform these technical steps:

1. **Unify to a square canvas** — the source is already 1254×1254 square.
2. **Make the white corners outside the cream rounded base plate transparent** on a
   per-pixel basis, leaving the cream base plate and the cat subject untouched.
3. **Set the color profile**, scale, and emit target container formats.
4. **High-quality downscaling + light sharpening** for tiny sizes only, to keep the
   cat recognizable. No different graphics may be drawn.

Forbidden: regenerating the image, blue-tinting, abstracting, or changing the cat's
colors, expression, or main outline. The cream base plate and cat subject must stay
visually consistent across every derived asset.

## How transparency is produced (no redraw)

The cream base plate touches the canvas edges on its four straight sides; only the
four rounded corners (~49 px radius) are white. The cat's white face sits centered
and is fully enclosed by non-white pixels (cream plate + colored cat features).

`generate_icons.py` therefore builds the alpha channel by flood-filling
"near-white" pixels (all RGB channels ≥ 250) seeded from every canvas-border
pixel. The flood-fill reaches only the four corner regions, so only those become
transparent. The enclosed cat-face white is never reached and stays fully opaque.
The alpha boundary traces the cream plate's anti-aliased edge, producing clean
transparency without altering the plate or the cat.

## macOS squircle safe area

The cat content is centered and already sits well inside the macOS squircle safe
area, so the system will not clip the subject. To honor the #114 rule that the
cream base plate and cat must not change, no additional squircle mask is imposed:
the original cream rounded-square plate is preserved on every platform. This is the
most conservative choice consistent with the spec boundary.

## Derivation pipeline

`generate_icons.py` is the single, reproducible entry point. Re-run from the repo
root:

```bash
python3 design/brand/generate_icons.py
```

It uses Pillow (PIL) for resizing/PNG emission and the macOS `iconutil` tool for
`.icns` generation. Multi-size `.ico` is written by a small PNG-embedded encoder
inside the script (PNG-compressed ICO entries, supported on Windows Vista+).

### Outputs

| Path | Platform | Sizes |
| --- | --- | --- |
| `resources/icons/icon.icns` | macOS | 16/32/64/128/256/512/1024 (+ retina @2x) |
| `resources/icons/icon.ico` | Windows | 16/32/48/64/128/256 |
| `resources/icons/icon-256.png` | Linux / general | 256×256 RGBA |
| `resources/icons/icon-512.png` | Linux hi-dpi / repo-grade | 512×512 RGBA |
| `resources/icons/icon-1024.png` | master reference | 1024×1024 RGBA |
| `resources/icons/icon-16/32/64.png` | tiny-size reference | 16/32/64 RGBA |
| `resources/icons/icon.png` | canonical RGBA master | 1254×1254 RGBA |
| `design/brand/skill-switch-avatar.png` | repository avatar | 512×512 RGBA |

### electron-builder wiring

`package.json` references these assets directly so packaging never falls back to the
Electron default icon:

- `build.mac.icon` → `resources/icons/icon.icns`
- `build.win.icon` → `resources/icons/icon.ico`
- `build.linux.icon` → `resources/icons/icon-512.png`

## Verification

Observable behavior is covered by `tests/brand-icons.test.ts`, which independently
parses PNG/ICO/ICNS bytes (no image dependency) to assert:

- the source SHA-256 matches the baseline and the source is a 1254×1254 RGB PNG;
- every derived asset exists with the correct dimensions and RGBA color type;
- the macOS `.icns` and Windows `.ico` contain all required sizes;
- the four corners are transparent while the cream plate and cat center stay opaque
  (at both 1024 px and the 16 px tiny size);
- `package.json` build config references generated icon assets that exist on disk.
