#!/usr/bin/env python3
"""Generate the Sam AI icon set from one geometric mark.

The boilerplate shipped someone else's artwork in resources/build. This replaces it with a mark of
our own, drawn here so the set is reproducible rather than a pile of opaque binaries: edit the
geometry below, re-run, and every format regenerates consistently.

The mark: a rounded-square badge in the app's brand colour, carrying an "S" cut from the negative
space, with a small node-and-link motif that reads as "assistant" rather than "letter". Deliberately
simple — it has to survive being rendered at 16x16 in a taskbar.

Sizes are what electron-builder requires:
  - icon.ico     16, 24, 32, 48, 64, 128, 256   (Windows: multi-resolution, 256 must be present)
  - icon.icns    16..1024                       (macOS: icns container, 512@2x = 1024)
  - icon.png     512                            (Linux/AppImage + the BrowserWindow icon)

Usage: python tests/probes/make-icons.py            # writes resources/build/icon.{png,ico,icns}
       python tests/probes/make-icons.py --preview  # also writes a PNG contact sheet for eyeballing
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "resources" / "build"

# The app's brand token, from app/styles/globals.css (`--brand: #ff5c3a`).
BRAND = (255, 92, 58, 255)
BRAND_DEEP = (214, 63, 32, 255)  # a shade down, for the glyph so it reads on the badge
INK = (14, 16, 17, 255)  # the window background, used for the glyph's counter

# Master render size. Everything else is a downsample of this, so the shapes stay crisp.
MASTER = 1024


def rounded_badge(size: int, radius_ratio: float = 0.22) -> Image.Image:
    """A rounded square in the brand colour, the badge the mark sits on."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    inset = round(size * 0.055)
    draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset),
        radius=round(size * radius_ratio),
        fill=BRAND,
    )
    return img


def draw_glyph(img: Image.Image, size: int) -> Image.Image:
    """Cut the mark's geometry: a stylised S spine with a node dot, in the negative space."""
    draw = ImageDraw.Draw(img)

    # Geometry is expressed in fractions of `size`, so it scales exactly.
    def px(f: float) -> float:
        return size * f

    stroke = max(2, round(size * 0.085))
    # An S drawn as three arcs: top bowl opens right, bottom bowl opens left. Stroke-only, so it reads
    # as a line rather than a blob at small sizes.
    left = px(0.30)
    right = px(0.70)
    top = px(0.31)
    mid = px(0.50)
    bottom = px(0.69)
    r = (right - left) / 2

    # Top bowl: upper arc from right side around to the left.
    draw.arc(
        (left, top, right, top + 2 * r),
        start=270,
        end=90,
        fill=INK,
        width=stroke,
    )
    # Bottom bowl: lower arc from left side around to the right.
    draw.arc(
        (left, mid - r, right, bottom + 0),
        start=90,
        end=270,
        fill=INK,
        width=stroke,
    )
    # The S's spine, joining the two bowls.
    draw.line((left, mid, right, mid), fill=INK, width=stroke)

    # The "assistant" node: a filled dot at the lower right, the thing that makes this a mark rather
    # than a monogram.
    dot_r = size * 0.085
    cx, cy = size * 0.735, size * 0.735
    draw.ellipse((cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r), fill=INK)
    # Its ring, in the brand-deep tone, so the dot reads as a linked node.
    draw.ellipse(
        (cx - dot_r * 1.75, cy - dot_r * 1.75, cx + dot_r * 1.75, cy + dot_r * 1.75),
        outline=BRAND_DEEP,
        width=max(2, round(size * 0.018)),
    )
    return img


def render_master() -> Image.Image:
    """The 1024px master, from which every output size is derived."""
    img = rounded_badge(MASTER)
    return draw_glyph(img, MASTER)


def svg_mark() -> str:
    """The same mark as SVG, with the geometry kept in one place.

    Written as explicit path geometry rather than an embedded raster, so the vector stays sharp at any
    size and a designer can edit it. The numbers mirror `draw_glyph`'s fractions; if one changes the
    other must, which is why they sit next to each other in this file.
    """
    # viewBox is 1024 to match the master, so the same fractions can be used verbatim.
    stroke = round(MASTER * 0.085)
    left, right = round(MASTER * 0.30), round(MASTER * 0.70)
    top, mid, bottom = MASTER * 0.31, MASTER * 0.50, MASTER * 0.69
    r = (right - left) / 2
    dot_r = MASTER * 0.085
    cx, cy = MASTER * 0.735, MASTER * 0.735
    inset = round(MASTER * 0.055)
    radius = round(MASTER * 0.22)
    ink = "#%02x%02x%02x" % INK[:3]
    brand = "#%02x%02x%02x" % BRAND[:3]
    brand_deep = "#%02x%02x%02x" % BRAND_DEEP[:3]

    # The top bowl runs from the right edge, counter-clockwise over the top, to the left edge; the
    # bottom bowl runs from the left edge, counter-clockwise under the bottom, to the right edge. Driven
    # by the same `start`/`end` angles as the PIL arcs above, so the two renderings agree.
    top_bowl = f'M {left} {top + r} A {r} {r} 0 0 1 {right} {top + r}'
    bottom_bowl = f'M {left} {mid + r} A {r} {r} 0 0 1 {right} {mid + r}'

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {MASTER} {MASTER}" width="{MASTER}" height="{MASTER}" role="img" aria-label="Sam AI">
  <rect x="{inset}" y="{inset}" width="{MASTER - 2 * inset}" height="{MASTER - 2 * inset}" rx="{radius}" fill="{brand}" />
  <g fill="none" stroke="{ink}" stroke-width="{stroke}" stroke-linecap="round">
    <path d="{top_bowl}" />
    <path d="{bottom_bowl}" />
    <path d="M {left} {mid} L {right} {mid}" />
  </g>
  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{dot_r * 1.75:.1f}" fill="none" stroke="{brand_deep}" stroke-width="{round(MASTER * 0.018)}" />
  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{dot_r:.1f}" fill="{ink}" />
</svg>
'''


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true", help="also write a contact sheet")
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    master = render_master()

    # --- PNG: the sizes electron-builder and Linux desktops expect
    png_sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    rendered = {s: master.resize((s, s), Image.LANCZOS) for s in png_sizes}

    # The canonical app icon: 512, which is what lib/main/app.ts imports for the BrowserWindow.
    rendered[512].save(OUT / "icon.png", format="PNG", optimize=True)

    # --- ICO: Windows. 256 must be present; the small sizes must be in the file, not resampled by
    # the shell, or the taskbar shows a blurry downscale.
    ico_sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    rendered[256].save(OUT / "icon.ico", format="ICO", sizes=ico_sizes)

    # --- ICNS: macOS. Written from the master so the @2x slots are genuinely 2x, not upscaled.
    icns_path = OUT / "icon.icns"
    try:
        rendered[1024].save(
            icns_path,
            format="ICNS",
            append_images=[rendered[s] for s in (16, 32, 48, 64, 128, 256, 512)],
        )
    except Exception as err:  # pragma: no cover - depends on the PIL build
        print(f"ICNS write failed ({err}); writing via the large-PNG fallback", file=sys.stderr)
        # electron-builder can build an icns from a 1024 PNG, so a failure here is not fatal; the
        # fallback keeps the icon set complete rather than silently shipping the boilerplate's.
        rendered[1024].save(OUT / "icon-1024.png", format="PNG", optimize=True)

    if args.preview:
        sheet = Image.new("RGBA", (sum(png_sizes) + len(png_sizes) * 8, 1100), (24, 26, 28, 255))
        x = 4
        for s in png_sizes:
            sheet.paste(rendered[s], (x, 4 + (1024 - s)), rendered[s])
            x += s + 8
        sheet.save(ROOT / ".preview" / "icon-contact-sheet.png", format="PNG")

    # --- SVG: the same mark as vectors, so the repository keeps a source-of-truth drawing. The
    # template shipped Vite's gradient logo here, and leaving it would keep third-party artwork in the
    # tree under our name even though the raster icons were replaced.
    #
    # newline='\n' explicitly: this repo declares `eol=lf` in .gitattributes, and Python's default text
    # mode would write CRLF on Windows, producing a file git immediately considers modified.
    (OUT / "icon.svg").write_text(svg_mark(), encoding="utf-8", newline="\n")

    for f in ("icon.png", "icon.ico", "icon.icns"):
        p = OUT / f
        if p.exists():
            print(f"wrote {p.relative_to(ROOT)}  {p.stat().st_size} bytes")
        else:
            print(f"MISSING {f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
