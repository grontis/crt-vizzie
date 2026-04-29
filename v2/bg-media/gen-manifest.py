#!/usr/bin/env python3
"""Generate manifest.json for the bg-media cycle feature.

Run from any directory:
    python v2/bg-media/gen-manifest.py

Or from the bg-media directory itself:
    python gen-manifest.py

Scans the directory this script lives in for supported media files,
sorts them alphabetically, and writes manifest.json next to the script.
"""

import json
from pathlib import Path

EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov'}

here = Path(__file__).parent.resolve()

files = sorted(
    p.name
    for p in here.iterdir()
    if p.is_file() and p.suffix.lower() in EXTENSIONS
)

manifest_path = here / 'manifest.json'
manifest_path.write_text(json.dumps(files, indent=2) + '\n', encoding='utf-8')

print(f'{len(files)} file(s) written to {manifest_path}')
