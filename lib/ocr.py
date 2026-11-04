#!/usr/bin/env python3
"""Prepare a phone screenshot for OCR: grayscale, upscale small captures, normalise contrast."""
import json
import sys

from PIL import Image, ImageOps

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("L")
scale = 1
if im.width < 900:
    scale = 3
elif im.width < 1400:
    scale = 2
if scale > 1:
    im = im.resize((im.width * scale, im.height * scale), Image.LANCZOS)
im = ImageOps.autocontrast(im)
im.save(dst)
print(json.dumps({"scale": scale, "width": im.width // scale, "height": im.height // scale}))
