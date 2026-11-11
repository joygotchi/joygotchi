"""Build a nine-row reference atlas from the game's own dragon.

One row per state, eight frames each, in `PET_STATES` order. Each row is a
real motion rather than the same picture nudged: the point of a reference
sheet is that somebody can open it and see what each row is supposed to
contain.
"""
import math
import sys
from PIL import Image

W, H, COLS, ROWS = 192, 208, 8, 9
STATES = ['idle', 'running-right', 'running-left', 'waving',
          'jumping', 'failed', 'waiting', 'running', 'review']


def pose(base, state, t):
    """One frame. `t` runs 0..1 across the row."""
    phase = math.sin(t * 2 * math.pi)
    pet = base.copy()
    dx = dy = 0
    angle = 0.0
    flip = False

    if state == 'idle':
        dy = round(-2 * phase)
    elif state == 'waiting':
        dy = round(-1 * phase)
        angle = 2 * phase
    elif state == 'running-right':
        dx = round(26 * (t - 0.5) * 2)
        dy = round(-6 * abs(phase))
        angle = -8
    elif state == 'running-left':
        dx = round(-26 * (t - 0.5) * 2)
        dy = round(-6 * abs(phase))
        angle = 8
        flip = True
    elif state == 'waving':
        angle = 12 * phase
        dy = round(-3 * abs(phase))
    elif state == 'jumping':
        dy = round(-34 * math.sin(t * math.pi))
    elif state == 'failed':
        dx = round(7 * math.sin(t * 4 * math.pi))
        angle = -6 * phase
        dy = round(4 * t)
    elif state == 'running':
        dy = round(-9 * abs(phase))
        angle = 4 * phase
    elif state == 'review':
        dx = round(8 * phase)
        angle = 5 * phase

    if flip:
        pet = pet.transpose(Image.FLIP_LEFT_RIGHT)
    if angle:
        pet = pet.rotate(angle, resample=Image.NEAREST, expand=False)

    cell = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    cell.alpha_composite(pet, ((W - pet.width) // 2 + dx, H - pet.height - 8 + dy))
    return cell


def build(source, out):
    gif = Image.open(source)
    sheet = Image.new('RGBA', (W * COLS, H * ROWS), (0, 0, 0, 0))
    for row, state in enumerate(STATES):
        for col in range(COLS):
            gif.seek(col % gif.n_frames)
            # Leave headroom for the jump and the rotations.
            base = gif.convert('RGBA').resize((150, 150), Image.NEAREST)
            sheet.alpha_composite(pose(base, state, col / COLS), (col * W, row * H))
    sheet.save(out)
    print('wrote', out, sheet.size)


if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2])
