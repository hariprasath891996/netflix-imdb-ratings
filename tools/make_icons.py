#!/usr/bin/env python3
"""Generate the extension's icons.

There is no image library on this machine, so this writes PNGs directly with
zlib and struct. That turns out to be a feature rather than a workaround: the
icons are reproducible from source, and tweaking the design is editing numbers
here rather than hunting for the original of a committed binary.

Design: a dark tile carrying three ascending bars in the extension's own red,
amber and green. It reads as a rating scale, it says "traffic light" at a
glance, and it survives being shrunk to 16px because it is three solid shapes
and no text.

    python3 tools/make_icons.py
"""
import struct
import zlib

# The exact colours the badge uses, so the icon and the product agree.
BG = (20, 20, 20)
BARS = [
    ((232, 124, 120), 0.30),  # red    - short
    ((229, 160, 13), 0.48),   # amber  - medium
    ((70, 211, 105), 0.68),   # green  - tall
]

SUPERSAMPLE = 8  # rendered this many times over, then box-averaged down


def rounded_rect_coverage(px, py, x0, y0, x1, y1, r):
    """Is this point inside the rounded rectangle?"""
    if not (x0 <= px <= x1 and y0 <= py <= y1):
        return False
    # Only the four corner boxes need the circle test.
    cx = x0 + r if px < x0 + r else (x1 - r if px > x1 - r else px)
    cy = y0 + r if py < y0 + r else (y1 - r if py > y1 - r else py)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def render(size):
    hi = size * SUPERSAMPLE
    # Accumulate colour per output pixel, then divide — cheap box filter, which
    # is all the anti-aliasing a shape this simple needs.
    acc = [[[0, 0, 0] for _ in range(size)] for _ in range(size)]

    tile_r = 0.22 * hi
    bar_w = 0.20 * hi
    gap = 0.085 * hi
    total = 3 * bar_w + 2 * gap
    bar_x0 = (hi - total) / 2
    bar_bottom = 0.80 * hi
    bar_r = 0.055 * hi

    for y in range(hi):
        py = y + 0.5
        oy = y // SUPERSAMPLE
        for x in range(hi):
            px = x + 0.5

            if not rounded_rect_coverage(px, py, 0, 0, hi, hi, tile_r):
                continue  # outside the tile: leave transparent-black

            colour = BG
            for index, (rgb, height) in enumerate(BARS):
                bx0 = bar_x0 + index * (bar_w + gap)
                by0 = bar_bottom - height * hi
                if rounded_rect_coverage(px, py, bx0, by0, bx0 + bar_w, bar_bottom, bar_r):
                    colour = rgb
                    break

            cell = acc[oy][x // SUPERSAMPLE]
            cell[0] += colour[0]
            cell[1] += colour[1]
            cell[2] += colour[2]

    # Alpha comes from how much of the output pixel the tile actually covered.
    cover = [[0] * size for _ in range(size)]
    for y in range(hi):
        py = y + 0.5
        for x in range(hi):
            if rounded_rect_coverage(x + 0.5, py, 0, 0, hi, hi, tile_r):
                cover[y // SUPERSAMPLE][x // SUPERSAMPLE] += 1

    n = SUPERSAMPLE * SUPERSAMPLE
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            covered = cover[y][x]
            if covered == 0:
                row += bytes((0, 0, 0, 0))
                continue
            r, g, b = (c // covered for c in acc[y][x])
            row += bytes((r, g, b, round(255 * covered / n)))
        rows.append(bytes(row))
    return rows


def write_png(path, rows):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    size = len(rows)
    raw = b"".join(b"\x00" + r for r in rows)  # filter type 0 per scanline
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


if __name__ == "__main__":
    for size in (16, 32, 48, 128):
        written = write_png(f"icons/icon{size}.png", render(size))
        print(f"  icons/icon{size}.png  {written:,} bytes")
