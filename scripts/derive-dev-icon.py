#!/usr/bin/env python3
"""Derive the local-environment launcher icon from the production one.

build/icon.png and resources/icon.png (the green "00", exported from design
node dQbHm) are the source; this writes build/icon-dev.png and
resources/icon-dev.png with the mark recolored to the app's destructive red so
a dev instance is unmistakable next to the installed release in a dock or
taskbar (src/main/app-icon.ts picks the file per environment,
scripts/dev-app-icon.sh stamps it on the dev Electron.app bundle).

Only the mark changes: a pixel is recolored when it lies on the straight line
between the squircle's background and the brand green (that is exactly the
anti-aliased edge of the glyphs); the squircle, its highlight rim and the
transparent corners are left untouched. Re-run after regenerating the green
icons. Needs Pillow (`python3 -m pip install pillow`).
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PAIRS = [
    (ROOT / "build" / "icon.png", ROOT / "build" / "icon-dev.png"),
    (ROOT / "resources" / "icon.png", ROOT / "resources" / "icon-dev.png"),
]

BACKGROUND = (15, 15, 18)  # the squircle fill the glyphs sit on
GREEN = (168, 201, 69)  # --electric-400, the brand mark
RED = (239, 68, 68)  # --destructive (light), the dev mark
# How far off the background→green line a pixel may sit and still count as
# part of the mark. The rim highlight (36,36,41) is ~16 away; glyph edges are 0.
MAX_RESIDUAL = 8.0
MIN_COVERAGE = 0.03


def recolor(px: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    r, g, b, a = px
    if a == 0:
        return px
    axis = tuple(gc - bc for gc, bc in zip(GREEN, BACKGROUND))
    offset = (r - BACKGROUND[0], g - BACKGROUND[1], b - BACKGROUND[2])
    axis_len2 = sum(c * c for c in axis)
    t = sum(o * c for o, c in zip(offset, axis)) / axis_len2
    if t < MIN_COVERAGE:
        return px
    # Measured against the unclamped line: the glyphs carry a one-pixel inner
    # rim slightly brighter than the brand green (t ~ 1.06), which must follow
    # the mark, so t is not clamped to 1 but carried into the red.
    residual = sum((o - t * c) ** 2 for o, c in zip(offset, axis)) ** 0.5
    if residual > MAX_RESIDUAL:
        return px
    channel = lambda i: max(0, min(255, round(BACKGROUND[i] + t * (RED[i] - BACKGROUND[i]))))
    return (channel(0), channel(1), channel(2), a)


def main() -> None:
    for src, dst in PAIRS:
        image = Image.open(src).convert("RGBA")
        out = Image.new("RGBA", image.size)
        out.putdata([recolor(px) for px in image.get_flattened_data()])
        out.save(dst, optimize=True)
        print(f"{dst.relative_to(ROOT)}: {out.size[0]}x{out.size[1]}")


if __name__ == "__main__":
    main()
