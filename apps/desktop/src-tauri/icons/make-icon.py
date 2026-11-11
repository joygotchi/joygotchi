#!/usr/bin/env python3
"""Rebuild the app icon from the game's own art.

The icon is the screen the app actually shows: the hill, the sky, and a
black dragon in its final form standing on the grass. Nothing here is
drawn by hand, so changing the game's art and re-running this keeps the
icon honest.

    python3 make-icon.py && pnpm exec tauri icon icons/source-1024.png

Then delete the `android/`, `ios/`, `Square*Logo.png` and `StoreLogo.png`
the generator also writes: this app ships to desktop only.
"""

from PIL import Image, ImageDraw
from pathlib import Path

HERE = Path(__file__).resolve().parent
ART = HERE.parent.parent / 'public' / 'assets'

# Apple's app-icon grid: the rounded body is ~80% of the canvas, so the icon
# sits at the same visual weight as every other one in a dock.
SIZE, BODY, RADIUS = 1024, 824, 185

# Crop toward the middle of the screen art. At 32 pixels an icon is a
# silhouette and nothing else, and full-frame left two thirds of it empty sky.
ZOOM = 0.72
# Where the dragon's feet land, down the body. It stands on grass, not in it.
FOOT = 0.92
# Whole-number upscale, or the pixels stop being pixels.
SCALE = 5


def main() -> None:
    screen = Image.open(ART / 'background' / 'screen_pet.png').convert('RGBA')
    w, h = screen.size
    side = int(w * ZOOM)
    left = (w - side) // 2
    # Keep more hill than sky: the dragon needs ground under it.
    top = int(h * (1 - ZOOM) * 0.75)
    body = screen.crop((left, top, left + side, top + side)).resize((BODY, BODY), Image.NEAREST)

    frame = Image.open(ART / 'animation' / 'blackdragon' / '3.gif')
    frame.seek(0)
    dragon = frame.convert('RGBA')
    box = dragon.getbbox()
    if box:
        dragon = dragon.crop(box)
    dragon = dragon.resize((dragon.width * SCALE, dragon.height * SCALE), Image.NEAREST)
    body.alpha_composite(dragon, ((BODY - dragon.width) // 2, int(BODY * FOOT) - dragon.height))

    mask = Image.new('L', (BODY, BODY), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, BODY - 1, BODY - 1], RADIUS, fill=255)
    body.putalpha(mask)

    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(body, ((SIZE - BODY) // 2, (SIZE - BODY) // 2))
    out = HERE / 'source-1024.png'
    canvas.save(out)
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
