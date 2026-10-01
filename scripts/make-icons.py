#!/usr/bin/env python3
"""Draws the Agent Status robot once and writes it everywhere it appears:

  media/agent-status.woff     the status bar glyph: product icon "agent-status-robot", U+E000
                              (the chip's live dots follow it, so it has none of its own)
  media/activity.svg          the activity bar icon: the robot with three dots under its head,
                              in one color, as VS Code paints activity bar icons
  media/icon.svg, icon.png    the extension icon: the same, with the dots in their status colors
                              and no background

Run with `python3 scripts/make-icons.py` after changing the drawing. Needs fontTools
(pip install fonttools) and Google Chrome or Chromium for the PNG.
"""

import os
import shutil
import subprocess
import tempfile

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

MEDIA = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'media')
K = 0.5522847498  # Cubic control distance for a quarter circle, per unit of radius.

# Status colors, as in the chip's dots: working, waiting, idle.
DOT_COLORS = ['#FBC02D', '#F44336', '#4CAF50']
# Two tones keep the transparent extension icon readable on light and dark pages: a light face
# inside a mid blue-grey outline.
FACE = '#ECEFF1'
OUTLINE = '#607D8B'
EYES = '#37474F'


# Contours are drawn on a 24x24 grid, y pointing down. Filled shapes go clockwise on screen and
# holes counter-clockwise, which is what TrueType expects and what SVG's nonzero rule fills.

def rounded_rect(x0, y0, x1, y1, r, clockwise=True):
    k = K * r
    segments = [
        ('M', (x0 + r, y0)),
        ('L', (x1 - r, y0)), ('C', (x1 - r + k, y0), (x1, y0 + r - k), (x1, y0 + r)),
        ('L', (x1, y1 - r)), ('C', (x1, y1 - r + k), (x1 - r + k, y1), (x1 - r, y1)),
        ('L', (x0 + r, y1)), ('C', (x0 + r - k, y1), (x0, y1 - r + k), (x0, y1 - r)),
        ('L', (x0, y0 + r)), ('C', (x0, y0 + r - k), (x0 + r - k, y0), (x0 + r, y0)),
    ]
    return segments if clockwise else reverse(segments)


def circle(cx, cy, r, clockwise=True):
    k = K * r
    segments = [
        ('M', (cx, cy - r)),
        ('C', (cx + k, cy - r), (cx + r, cy - k), (cx + r, cy)),
        ('C', (cx + r, cy + k), (cx + k, cy + r), (cx, cy + r)),
        ('C', (cx - k, cy + r), (cx - r, cy + k), (cx - r, cy)),
        ('C', (cx - r, cy - k), (cx - k, cy - r), (cx, cy - r)),
    ]
    return segments if clockwise else reverse(segments)


def reverse(segments):
    pieces, current = [], segments[0][1]
    for segment in segments[1:]:
        pieces.append((current, segment))
        current = segment[-1]
    reversed_segments = [('M', current)]
    for start, segment in reversed(pieces):
        if segment[0] == 'L':
            reversed_segments.append(('L', start))
        else:
            reversed_segments.append(('C', segment[2], segment[1], start))
    return reversed_segments


def outline():
    return [
        rounded_rect(3.2, 8.4, 20.8, 21.0, 3.4),  # head
        rounded_rect(4.8, 10.0, 19.2, 19.4, 1.8, clockwise=False),  # inside the head
        rounded_rect(11.2, 5.4, 12.8, 8.8, 0.3),  # antenna
        circle(12, 4.2, 1.7),
        rounded_rect(1.0, 12.6, 2.6, 16.8, 0.8),  # ears
        rounded_rect(21.4, 12.6, 23.0, 16.8, 0.8),
    ]


def face():
    return [rounded_rect(4.8, 10.0, 19.2, 19.4, 1.8)]


def eyes():
    return [circle(8.8, 14.7, 1.6), circle(15.2, 14.7, 1.6)]


def robot():
    return outline() + eyes()


# The three status dots under the head, in grid units: centers and radius.
DOT_XS = (6.0, 12.0, 18.0)
DOT_R = 1.9


def dots(cy):
    return [circle(x, cy, DOT_R) for x in DOT_XS]


def transform(contours, scale, dx, dy):
    """Scales and moves contours drawn on the grid."""
    def point(p):
        return (p[0] * scale + dx, p[1] * scale + dy)

    return [[(segment[0], *[point(p) for p in segment[1:]]) for segment in segments] for segments in contours]


def path_data(contours, scale=1.0, dx=0.0, dy=0.0):
    def point(p):
        return f'{p[0] * scale + dx:.3f} {p[1] * scale + dy:.3f}'

    parts = []
    for segments in contours:
        for segment in segments:
            if segment[0] == 'M':
                parts.append(f'M{point(segment[1])}')
            elif segment[0] == 'L':
                parts.append(f'L{point(segment[1])}')
            else:
                parts.append(f'C{point(segment[1])} {point(segment[2])} {point(segment[3])}')
        parts.append('Z')
    return ''.join(parts)


def write_font(path):
    unit = 50
    upm = 24 * unit
    tt = TTGlyphPen(None)
    # Flip y (fonts point up) and turn the cubic curves into TrueType's quadratic ones.
    pen = TransformPen(Cu2QuPen(tt, max_err=0.5), (unit, 0, 0, -unit, 0, upm))
    for segments in robot():
        for segment in segments:
            if segment[0] == 'M':
                pen.moveTo(segment[1])
            elif segment[0] == 'L':
                pen.lineTo(segment[1])
            else:
                pen.curveTo(segment[1], segment[2], segment[3])
        pen.closePath()

    builder = FontBuilder(upm, isTTF=True)
    builder.setupGlyphOrder(['.notdef', 'robot'])
    builder.setupCharacterMap({0xE000: 'robot'})
    builder.setupGlyf({'.notdef': TTGlyphPen(None).glyph(), 'robot': tt.glyph()})
    glyph = builder.font['glyf']['robot']
    glyph.recalcBounds(builder.font['glyf'])
    builder.setupHorizontalMetrics({'.notdef': (upm, 0), 'robot': (upm, glyph.xMin)})
    # Like VS Code's codicons: the glyph fills the em square, with no descent.
    builder.setupHorizontalHeader(ascent=upm, descent=0)
    builder.setupNameTable({'familyName': 'Agent Status Icons', 'styleName': 'Regular'})
    builder.setupOS2(sTypoAscender=upm, sTypoDescender=0, sTypoLineGap=0, usWinAscent=upm, usWinDescent=0)
    builder.setupPost()
    builder.font.flavor = 'woff'
    builder.save(path)


def activity_svg():
    # The robot shrunk to the top of the square, with room for the dots under its head.
    scale = 0.8
    head = transform(robot(), scale, 12 * (1 - scale), -0.2)
    contours = head + dots(21.3)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
        f'<path fill="#C5C5C5" d="{path_data(contours)}"/></svg>\n'
    )


def icon_svg():
    # No background: the robot and its dots fill the square, leaving a small margin.
    scale = 5.0
    dx = 64 - 12 * scale
    dy = 4.2 - 2.5 * scale  # The antenna's top (y 2.5 on the grid) starts 4 px from the top.
    cy = 21.0 * scale + dy + 8 + DOT_R * scale  # Dots 8 px under the head.
    status = ''.join(
        f'<circle cx="{64 + (x - 12) * scale:.2f}" cy="{cy:.2f}" r="{DOT_R * scale:.2f}" fill="{color}"/>'
        for x, color in zip(DOT_XS, DOT_COLORS)
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">'
        f'<path fill="{FACE}" d="{path_data(face(), scale, dx, dy)}"/>'
        f'<path fill="{OUTLINE}" d="{path_data(outline(), scale, dx, dy)}"/>'
        f'<path fill="{EYES}" d="{path_data(eyes(), scale, dx, dy)}"/>'
        f'{status}</svg>\n'
    )


def find_chrome():
    for name in (os.environ.get('CHROME'), 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'):
        if name and shutil.which(name):
            return shutil.which(name)
    raise SystemExit('Google Chrome or Chromium not found; set CHROME.')


def write_png(svg, path, size=128):
    work = tempfile.mkdtemp(prefix='agent-status-icon-')
    try:
        html = os.path.join(work, 'icon.html')
        with open(html, 'w') as f:
            f.write(f'<!doctype html><html><body style="margin:0;background:transparent">{svg}</body></html>')
        subprocess.run(
            [
                find_chrome(), '--headless=new', '--disable-gpu', '--hide-scrollbars',
                f'--user-data-dir={os.path.join(work, "profile")}', '--default-background-color=00000000',
                f'--window-size={size},{size}', f'--screenshot={path}', f'file://{html}',
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    write_font(os.path.join(MEDIA, 'agent-status.woff'))
    with open(os.path.join(MEDIA, 'activity.svg'), 'w') as f:
        f.write(activity_svg())
    svg = icon_svg()
    with open(os.path.join(MEDIA, 'icon.svg'), 'w') as f:
        f.write(svg)
    write_png(svg, os.path.join(MEDIA, 'icon.png'))
    for name in ('agent-status.woff', 'activity.svg', 'icon.svg', 'icon.png'):
        print(f'Wrote media/{name}')


if __name__ == '__main__':
    main()
