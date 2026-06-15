# mkv-convert

A small GUI utility that transcodes video files (MKV, AVI, MOV, etc.) to
browser-compatible MP4 (H.264 + AAC) using ffmpeg.  Intended for preparing
background video files for use with the crt-vizzie v2 visualizer.

## Prerequisites

- **Python 3.8+** with Tkinter
  ```
  sudo apt install python3-tk
  ```
- **ffmpeg 4.0+** (includes ffprobe)
  ```
  sudo apt install ffmpeg
  ```

## Usage

Run from the repo root:

```
python3 tools/mkv-convert/convert.py
```

1. Click **Browse...** next to *Source video* and select your input file.
2. The *Output file* field auto-populates with a sibling `.mp4` path.
   Override it with the second **Browse...** button if needed.
3. Click **Convert** and watch the progress bar.
4. Click **Cancel** at any time to stop; the partial output file is deleted.

## Output settings

| Setting | Value |
|---------|-------|
| Video codec | H.264 (`libx264`) |
| Preset | `slow` (better compression, longer encode) |
| CRF | 18 (near-lossless quality) |
| Audio codec | AAC |
| Audio bitrate | 128 kbps |
| Container | MP4 with `faststart` (moov atom at front) |

These settings are fixed.  If you need different settings, edit
`FFMPEG_FLAGS` at the top of `convert.py`.

## After conversion

Drop the `.mp4` output into whatever folder the visualizer's bg-folder picker
(M key) points at — typically `v2/bg-media/`:

```
cp output.mp4 v2/bg-media/
```

The playlist is read live from the filesystem via the File System Access API,
so no manifest step is needed. Use the **ArrowLeft / ArrowRight** keys to
cycle to it, or press **L** to load it directly from any path.

## Running the tests

From the repo root:

```
python3 -m unittest discover -s tools/mkv-convert -p 'test_*.py' -v
```

## Notes

- The tool is Linux-first.  It may work on macOS (Homebrew ffmpeg + Tkinter)
  but this is untested.
- Minimum ffmpeg version: 4.0 (2018).  The `-progress pipe:1` flag is
  required.
- If `libx264` is missing from your ffmpeg build (common with some snap
  packages), the error log will include an `apt install` hint.
