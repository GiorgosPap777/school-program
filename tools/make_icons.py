#!/usr/bin/env python3
"""Generate the PWA icon set. Standard library only — no Pillow, no build step.

    python3 tools/make_icons.py

Draws a timetable grid: white period bars with one amber "current" bar, the same
visual idea the app itself uses. Everything is axis-aligned rounded rectangles,
supersampled 4x for clean edges.
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(os.path.dirname(HERE), "icons")

BG = (0x1D, 0x4E, 0xD8)       # blue-700, matches --accent / theme-color
BAR = (0xFF, 0xFF, 0xFF)
NOW = (0xF5, 0x9E, 0x0B)      # amber-500, the "τώρα" highlight
SS = 4                        # supersampling factor


class Canvas:
    def __init__(self, size, rgba=(0, 0, 0, 0)):
        self.size = size
        self.px = bytearray(rgba * size * size)

    def _blend(self, i, color, alpha):
        if alpha <= 0:
            return
        if alpha >= 1 and len(color) == 3:
            self.px[i:i + 4] = bytes(color) + b"\xff"
            return
        for c in range(3):
            old = self.px[i + c]
            self.px[i + c] = int(old + (color[c] - old) * alpha)
        self.px[i + 3] = max(self.px[i + 3], int(255 * alpha))

    def rounded_rect(self, x0, y0, x1, y1, radius, color):
        r = min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
        for y in range(max(0, int(y0)), min(self.size, int(y1) + 1)):
            for x in range(max(0, int(x0)), min(self.size, int(x1) + 1)):
                cx = min(max(x + 0.5, x0 + r), x1 - r)
                cy = min(max(y + 0.5, y0 + r), y1 - r)
                dx, dy = x + 0.5 - cx, y + 0.5 - cy
                if dx * dx + dy * dy <= r * r:
                    self._blend((y * self.size + x) * 4, color, 1.0)

    def downsample(self, factor):
        out = Canvas(self.size // factor)
        n = factor * factor
        for y in range(out.size):
            for x in range(out.size):
                acc = [0, 0, 0, 0]
                for sy in range(factor):
                    for sx in range(factor):
                        i = ((y * factor + sy) * self.size + (x * factor + sx)) * 4
                        for c in range(4):
                            acc[c] += self.px[i + c]
                i = (y * out.size + x) * 4
                out.px[i:i + 4] = bytes(v // n for v in acc)
        return out

    def flatten(self, background):
        """Composite onto an opaque background — iOS rejects transparency."""
        out = Canvas(self.size)
        for i in range(0, len(self.px), 4):
            a = self.px[i + 3] / 255
            for c in range(3):
                out.px[i + c] = int(background[c] + (self.px[i + c] - background[c]) * a)
            out.px[i + 3] = 255
        return out

    def write_png(self, path):
        raw = b"".join(
            b"\x00" + bytes(self.px[y * self.size * 4:(y + 1) * self.size * 4])
            for y in range(self.size)
        )

        def chunk(tag, data):
            body = tag + data
            return (struct.pack(">I", len(data)) + body
                    + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))

        png = (b"\x89PNG\r\n\x1a\n"
               + chunk(b"IHDR", struct.pack(">IIBBBBB", self.size, self.size, 8, 6, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(raw, 9))
               + chunk(b"IEND", b""))
        with open(path, "wb") as fh:
            fh.write(png)
        return len(png)


def draw(size, corner=0.22, art_pad=0.20):
    """Render the icon at `size`.

    `corner` is the background's corner radius as a fraction of the side (0 for
    a full-bleed square). `art_pad` is the margin around the bars, also as a
    fraction of the side — maskable icons need a bigger one so the art survives
    the launcher's circular crop.
    """
    s = size * SS
    c = Canvas(s)
    c.rounded_rect(0, 0, s, s, s * corner, BG)

    # Five period bars, the middle one highlighted as "now".
    pad = s * art_pad
    gx0, gy0 = pad, pad
    gw = gh = s - 2 * pad
    rows, gap = 5, gh * 0.075
    bar_h = (gh - gap * (rows - 1)) / rows
    widths = [1.0, 0.72, 1.0, 0.56, 0.86]
    for i in range(rows):
        by = gy0 + i * (bar_h + gap)
        colour = NOW if i == 2 else BAR
        c.rounded_rect(gx0, by, gx0 + gw * widths[i], by + bar_h, bar_h * 0.35, colour)

    return c.downsample(SS)


def main():
    os.makedirs(ICONS, exist_ok=True)
    targets = [
        # name,                 size, corner, art_pad, opaque
        ("icon-192.png",         192,   0.22,    0.20, False),
        ("icon-512.png",         512,   0.22,    0.20, False),
        # Maskable: background bleeds to the edges (the launcher applies its own
        # shape) and the art stays inside the inner 80% safe zone.
        ("maskable-512.png",     512,   0.00,    0.28, False),
        # iOS applies its own rounding and rejects transparency.
        ("apple-touch-icon.png", 180,   0.00,    0.20, True),
        ("favicon-32.png",        32,   0.22,    0.16, False),
    ]
    for name, size, corner, art_pad, opaque in targets:
        c = draw(size, corner=corner, art_pad=art_pad)
        if opaque:
            c = c.flatten(BG)
        n = c.write_png(os.path.join(ICONS, name))
        print("  %-22s %4dx%-4d %6d bytes" % (name, size, size, n))


if __name__ == "__main__":
    main()
