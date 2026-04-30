# video-clipper

A small GUI utility for trimming a video file to a selected in/out range and
exporting the clip via ffmpeg.  Intended for preparing short background video
loops for use with the crt-vizzie v2 visualizer on a Raspberry Pi + CRT TV.

## Prerequisites

### Python and PyQt6

- **Python 3.10+**
- **PyQt6** (includes `QtMultimedia` and `QtMultimediaWidgets`):
  ```
  pip install PyQt6
  ```
  Do **not** use the distro package (`python3-pyqt6`) — older versions may lack
  the QtMultimedia APIs required for video playback.

### ffmpeg

- **ffmpeg 4.0+** (includes ffprobe):
  ```
  sudo apt install ffmpeg
  ```

### GStreamer codecs (Linux only)

On Linux, `QMediaPlayer` uses GStreamer as its media backend.  For H.264/AAC
playback you need the GStreamer plugin packages:

```
sudo apt install \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-libav
```

On macOS/Windows, the platform's native media framework (AVFoundation /
Media Foundation) is used instead — no extra codecs needed.

## Usage

Run from the repo root:

```
python3 tools/video-clipper/clip.py
```

### Single clip export

1. Click **Browse...** next to *Input* to select a video file.
2. Use the **Play / Pause / Stop** buttons or click anywhere on the
   timeline bar to navigate.
3. Seek to your desired start time and click **Set In**.
4. Seek to your desired end time and click **Set Out**.
5. Drag the green (in) and red (out) handles on the timeline to fine-tune.
6. Click **Preview** to watch the selected range before exporting.
7. The *Output* field auto-populates with a sibling file name.
   Override it or click the output **Browse...** button.
8. Tick **Frame-accurate (re-encode)** if you need a cut that starts and
   ends precisely on the chosen frames rather than on the nearest keyframe.
9. When re-encode is checked, choose a **Preset**, **Resolution**, and **CRF**
   (or leave them at their defaults).
10. Click **Export** and watch the progress bar.
11. Click **Cancel** at any time to stop; the partial output file is deleted.

### Batch export

Queue multiple clips from one or more files and export them all in one run:

1. Set up a clip as above (in/out points, output path, re-encode settings).
2. Click **Add to Batch** instead of *Export* — the clip is added to the
   **Batch Queue** panel as a *Pending* row.
3. Repeat for as many clips as you need (load different source files between
   additions if required).
4. Optionally set **Parallel jobs** (1–4) to run multiple exports concurrently.
5. Click **Run Batch**.  Each row in the table transitions
   Pending → Running → Done (or Error).
6. Click **Cancel Batch** to stop; active jobs are terminated and pending jobs
   are marked Cancelled.  Partial output files are deleted.

You can still play back / preview the loaded file while the batch is running.
To remove a queued item before it starts, select its row and click
**Remove Selected**.

## Output settings

### Default: stream copy (fast)

| Setting | Value |
|---------|-------|
| Method | `-c copy` (no re-encode) |
| Seek | Fast — cuts at nearest keyframe before in-point |
| Speed | Near-instant (bitstream remux only) |

### Frame-accurate: re-encode

Tick **Frame-accurate (re-encode with libx264/AAC)** to enable re-encoding.
Three additional dropdowns become active:

#### Preset

Picks a named profile that fills in Resolution and CRF at once.

| Preset | Resolution | CRF | Audio |
|--------|-----------|-----|-------|
| Original | unchanged | 18 | 128 kbps |
| Pi Streaming | 480p (aspect-preserving) | 23 | 96 kbps |
| CRT Compact | 720×480, 4:3 stretch + SAR reset | 28 | 64 kbps |
| 360p Tiny | 360p (aspect-preserving) | 32 | 64 kbps |

#### Resolution

Override the resolution independently of the preset.

| Option | ffmpeg filter |
|--------|--------------|
| Original | (no scaling) |
| 720p (1280×720) | `scale=-2:720` |
| 480p (854×480 16:9) | `scale=-2:480` |
| CRT/SD (720×480 4:3) | `scale=720:480,setsar=1` |
| 360p (640×360) | `scale=-2:360` |

**CRT/SD** stretches the image to fill a 4:3 frame — intentional for
composite-out CRT displays.  Use *480p (16:9)* if you want letterboxing
instead.

#### CRF (quality)

| Option | CRF | Notes |
|--------|-----|-------|
| High (CRF 18) | 18 | Near-lossless |
| Medium (CRF 23) | 23 | Good balance |
| CRT-optimized (CRF 28) | 28 | Smaller file; CRT hides artifacts |
| Tiny (CRF 32) | 32 | Smallest file |

All re-encode output uses H.264 (`libx264`), AAC audio, and the MP4
`faststart` flag (moov atom at front — needed for streaming playback on Pi).

## After export

Place the `.mp4` output in `v2/bg-media/` and use the **M** key in the
visualizer to pick the folder, or press **L** to load a single file directly.
Use **ArrowLeft / ArrowRight** to cycle through the folder playlist.

## Running the tests

From the repo root:

```
python3 -m unittest discover -s tools/video-clipper -p 'test_*.py' -v
```

Tests cover all pure helper functions and require no display or PyQt6
installation.

## Notes

- The tool is Linux-first.  It works on macOS and Windows (PyQt6 is
  cross-platform) but codec installation differs — see the PyQt6 and
  GStreamer prerequisites above.
- Minimum clip duration is 100 ms; shorter clips are rejected with a
  validation error.
- Stream copy clips may start slightly before the chosen in-point if the
  nearest keyframe is earlier.  Use **Frame-accurate** when exact frame
  precision is required.
- If `QMediaPlayer` cannot open a file, the error message from the Qt
  media backend appears in the status bar at the bottom of the window.
- For Pi/CRT use, **Pi Streaming** or **CRT Compact** presets are recommended.
  Both produce small files that decode easily at 480p on a Pi 4/5.
