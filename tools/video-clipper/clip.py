#!/usr/bin/env python3
"""Video Clipper — select in/out points and export a clip via ffmpeg.

Requires PyQt6 and ffmpeg (which includes ffprobe).

Run:
    python3 tools/video-clipper/clip.py
"""

import json
import os
import queue
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Pure helpers — no Qt dependency; importable by unit tests without a display
# ---------------------------------------------------------------------------


def format_time(ms: int) -> str:
    """Format *ms* milliseconds as HH:MM:SS.mmm.

    Examples:
        format_time(0)         -> '00:00:00.000'
        format_time(1000)      -> '00:00:01.000'
        format_time(3661001)   -> '01:01:01.001'
    """
    ms = max(0, int(ms))
    millis = ms % 1000
    total_s = ms // 1000
    secs = total_s % 60
    total_m = total_s // 60
    mins = total_m % 60
    hours = total_m // 60
    return f"{hours:02d}:{mins:02d}:{secs:02d}.{millis:03d}"


def default_clip_output(input_path: str, start_ms: int, end_ms: int) -> str:
    """Return a sibling output path derived from *input_path* and the clip range.

    Example: /home/user/video.mp4 with start=1000, end=5000
             -> /home/user/video_clip_1000-5000.mp4
    """
    p = Path(input_path)
    stem = p.stem
    parent = p.parent
    return str(parent / f"{stem}_clip_{int(start_ms)}-{int(end_ms)}.mp4")


def default_clip_filename(input_path: str, in_ms: int, out_ms: int) -> str:
    """Return a filename (no directory) for a clip derived from *input_path* and range.

    The format is: <stem>_<in_mm>m<in_ss>s-<out_mm>m<out_ss>s.mp4

    Examples:
        default_clip_filename('/a/video.mp4', 5000, 30000)
            -> 'video_0m05s-0m30s.mp4'
        default_clip_filename('/a/video.mkv', 0, 90000)
            -> 'video_0m00s-1m30s.mp4'
    """
    stem = Path(input_path).stem

    def _fmt(ms: int) -> str:
        ms = max(0, int(ms))
        total_s = ms // 1000
        mins = total_s // 60
        secs = total_s % 60
        return f"{mins}m{secs:02d}s"

    return f"{stem}_{_fmt(in_ms)}-{_fmt(out_ms)}.mp4"


def build_copy_cmd(
    input: str, output: str, start_s: float, duration_s: float
) -> list[str]:
    """Return an ffmpeg stream-copy command for *input* -> *output*.

    Uses fast input seek (-ss before -i) with -to specifying the duration
    of the output clip. No re-encode: fastest possible export.
    """
    return [
        "ffmpeg",
        "-y",
        "-ss", str(start_s),
        "-i", input,
        "-to", str(duration_s),
        "-c", "copy",
        "-progress", "pipe:1",
        "-nostats",
        output,
    ]


def build_reencode_cmd(
    input: str,
    output: str,
    start_s: float,
    duration_s: float,
    *,
    scale_filter: str | None = None,
    crf: int = 18,
    audio_bitrate: str = "128k",
) -> list[str]:
    """Return an ffmpeg re-encode command for *input* -> *output*.

    Uses libx264 + AAC for frame-accurate cuts at the cost of encode time.
    When *scale_filter* is not None, a -vf flag is inserted before -c:v.
    """
    cmd = [
        "ffmpeg",
        "-y",
        "-ss", str(start_s),
        "-i", input,
        "-to", str(duration_s),
    ]
    if scale_filter is not None:
        cmd += ["-vf", scale_filter]
    cmd += [
        "-c:v", "libx264",
        "-crf", str(crf),
        "-c:a", "aac",
        "-b:a", audio_bitrate,
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        output,
    ]
    return cmd


def validate_export(
    input_path: str,
    output_path: str,
    start_ms: int,
    end_ms: int,
) -> str | None:
    """Validate the export parameters.  Returns an error string or None on success.

    Checks (in order):
      1. Input non-empty.
      2. Input file exists.
      3. Input file is readable.
      4. Output non-empty.
      5. Output differs from input.
      6. Output directory exists and is writable.
      7. start_ms >= 0.
      8. end_ms > start_ms.
      9. Clip duration >= 100 ms.
    """
    if not input_path:
        return "Please select a source video file."
    inp = Path(input_path)
    if not inp.exists():
        return f"Input file not found: {input_path}"
    if not os.access(input_path, os.R_OK):
        return "Cannot read input file (permission denied)."
    if not output_path:
        return "Please specify an output file path."
    out = Path(output_path)
    if inp.resolve() == out.resolve():
        return "Output path must differ from input path."
    out_dir = out.parent
    if not out_dir.exists():
        return f"Output directory does not exist: {out_dir}"
    if not os.access(str(out_dir), os.W_OK):
        return f"Output directory is not writable: {out_dir}"
    if start_ms < 0:
        return "In-point must be >= 0."
    if end_ms <= start_ms:
        return "Out-point must be after in-point."
    if (end_ms - start_ms) < 100:
        return "Clip must be at least 100 ms long."
    return None


def parse_duration(ffprobe_stdout: str) -> float | None:
    """Parse ffprobe JSON output and return duration in seconds, or None.

    Accepts the stdout string from:
        ffprobe -v quiet -print_format json -show_format <file>
    """
    try:
        data = json.loads(ffprobe_stdout)
        return float(data["format"]["duration"])
    except (json.JSONDecodeError, KeyError, ValueError, TypeError):
        return None


def parse_progress_line(line: str) -> tuple[str, str] | None:
    """Parse a single ffmpeg -progress pipe:1 key=value line.

    Returns (key, value) or None if the line is not in key=value form.
    """
    line = line.strip()
    if "=" not in line:
        return None
    key, _, value = line.partition("=")
    return key.strip(), value.strip()


def progress_percent(out_time_ms_value: str, duration_s: float) -> float | None:
    """Convert an out_time_ms value string to a progress percentage.

    *out_time_ms_value* is the raw string from the ffmpeg progress line
    (microseconds, despite the name).  Returns a float in [0, 100] or None
    if the value cannot be parsed.
    """
    try:
        elapsed_us = int(out_time_ms_value)
    except (ValueError, TypeError):
        return None
    if duration_s is None or duration_s <= 0:
        return None
    return min(100.0, elapsed_us / (duration_s * 1_000_000) * 100.0)


def delete_partial_output(output_path: str) -> None:
    """Remove *output_path* if it exists (called on cancel)."""
    try:
        p = Path(output_path)
        if p.exists():
            p.unlink()
    except OSError:
        pass


EXPORT_PRESETS = [
    {"label": "Original",     "scale_filter": None,                     "crf": 18, "audio_bitrate": "128k"},
    {"label": "Pi Streaming", "scale_filter": "scale=-2:480",           "crf": 23, "audio_bitrate": "96k"},
    {"label": "CRT Compact",  "scale_filter": "scale=720:480,setsar=1", "crf": 28, "audio_bitrate": "64k"},
    {"label": "360p Tiny",    "scale_filter": "scale=-2:360",           "crf": 32, "audio_bitrate": "64k"},
]

RESOLUTION_OPTIONS = [
    {"label": "Original",             "scale_filter": None},
    {"label": "720p (1280x720)",      "scale_filter": "scale=-2:720"},
    {"label": "480p (854x480 16:9)",  "scale_filter": "scale=-2:480"},
    {"label": "CRT/SD (720x480 4:3)", "scale_filter": "scale=720:480,setsar=1"},
    {"label": "360p (640x360)",       "scale_filter": "scale=-2:360"},
]

CRF_OPTIONS = [
    {"label": "High (CRF 18)",          "crf": 18},
    {"label": "Medium (CRF 23)",        "crf": 23},
    {"label": "CRT-optimized (CRF 28)", "crf": 28},
    {"label": "Tiny (CRF 32)",          "crf": 32},
]


@dataclass
class BatchItem:
    input_path: str
    output_path: str
    start_ms: int
    end_ms: int
    reencode: bool
    scale_filter: str | None
    crf: int
    audio_bitrate: str
    status: str = "Pending"   # Pending | Running | Done | Error | Cancelled
    progress: float = 0.0
    error_detail: str = ""


def make_batch_item(input_path, output_path, start_ms, end_ms, reencode, scale_filter, crf, audio_bitrate):
    """Return (BatchItem, None) or (None, error_str)."""
    err = validate_export(input_path, output_path, start_ms, end_ms)
    if err:
        return None, err
    return BatchItem(
        input_path=input_path, output_path=output_path,
        start_ms=start_ms, end_ms=end_ms, reencode=reencode,
        scale_filter=scale_filter, crf=crf, audio_bitrate=audio_bitrate,
    ), None


def batch_item_row_text(item):
    """Return (source_name, range_str, output_name, status) for table display."""
    src = Path(item.input_path).name
    rng = f"{format_time(item.start_ms)} – {format_time(item.end_ms)}"
    out = Path(item.output_path).name
    return src, rng, out, item.status


def batch_progress_label(done: int, total: int) -> str:
    return f"{done} of {total} done"


# ---------------------------------------------------------------------------
# Qt imports — deferred to avoid import-time failures in headless unit tests
# ---------------------------------------------------------------------------

def _import_qt():
    """Import and return the Qt modules used by the GUI.

    Separated so that test_clip.py can import pure helpers without needing
    PyQt6 to be installed.
    """
    from PyQt6.QtCore import (
        Qt, QSize, QTimer, QUrl, pyqtSignal, QThread,
    )
    from PyQt6.QtGui import QColor, QPainter, QPen
    from PyQt6.QtMultimedia import QAudioOutput, QMediaPlayer
    from PyQt6.QtMultimediaWidgets import QVideoWidget
    from PyQt6.QtWidgets import (
        QAbstractItemView, QApplication, QCheckBox, QComboBox, QFileDialog,
        QGroupBox, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QMainWindow,
        QProgressBar, QPushButton, QSizePolicy, QSlider, QSpinBox, QStatusBar,
        QStyle, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
    )
    return {
        "Qt": Qt, "QSize": QSize, "QTimer": QTimer, "QUrl": QUrl,
        "pyqtSignal": pyqtSignal, "QThread": QThread,
        "QColor": QColor, "QPainter": QPainter, "QPen": QPen,
        "QAudioOutput": QAudioOutput, "QMediaPlayer": QMediaPlayer,
        "QVideoWidget": QVideoWidget,
        "QAbstractItemView": QAbstractItemView,
        "QApplication": QApplication, "QCheckBox": QCheckBox,
        "QComboBox": QComboBox, "QFileDialog": QFileDialog,
        "QGroupBox": QGroupBox,
        "QHBoxLayout": QHBoxLayout, "QHeaderView": QHeaderView,
        "QLabel": QLabel, "QLineEdit": QLineEdit,
        "QMainWindow": QMainWindow, "QProgressBar": QProgressBar,
        "QPushButton": QPushButton, "QSizePolicy": QSizePolicy,
        "QSlider": QSlider, "QSpinBox": QSpinBox,
        "QStatusBar": QStatusBar, "QStyle": QStyle,
        "QTableWidget": QTableWidget, "QTableWidgetItem": QTableWidgetItem,
        "QVBoxLayout": QVBoxLayout,
        "QWidget": QWidget,
    }


# ---------------------------------------------------------------------------
# Worker thread — runs ffprobe + ffmpeg off the main thread
# ---------------------------------------------------------------------------

def _build_gui():
    """Build and run the PyQt6 application.

    Imported Qt classes live inside this function so that importing clip.py
    as a module in a headless test environment does not raise display errors.
    """
    qt = _import_qt()
    Qt = qt["Qt"]
    QSize = qt["QSize"]
    QTimer = qt["QTimer"]
    QUrl = qt["QUrl"]
    pyqtSignal = qt["pyqtSignal"]
    QThread = qt["QThread"]
    QColor = qt["QColor"]
    QPainter = qt["QPainter"]
    QPen = qt["QPen"]
    QAudioOutput = qt["QAudioOutput"]
    QMediaPlayer = qt["QMediaPlayer"]
    QVideoWidget = qt["QVideoWidget"]
    QAbstractItemView = qt["QAbstractItemView"]
    QApplication = qt["QApplication"]
    QCheckBox = qt["QCheckBox"]
    QComboBox = qt["QComboBox"]
    QFileDialog = qt["QFileDialog"]
    QGroupBox = qt["QGroupBox"]
    QHBoxLayout = qt["QHBoxLayout"]
    QHeaderView = qt["QHeaderView"]
    QLabel = qt["QLabel"]
    QLineEdit = qt["QLineEdit"]
    QMainWindow = qt["QMainWindow"]
    QProgressBar = qt["QProgressBar"]
    QPushButton = qt["QPushButton"]
    QSizePolicy = qt["QSizePolicy"]
    QSlider = qt["QSlider"]
    QSpinBox = qt["QSpinBox"]
    QStatusBar = qt["QStatusBar"]
    QStyle = qt["QStyle"]
    QTableWidget = qt["QTableWidget"]
    QTableWidgetItem = qt["QTableWidgetItem"]
    QVBoxLayout = qt["QVBoxLayout"]
    QWidget = qt["QWidget"]

    # -----------------------------------------------------------------------
    # ExportWorker — QThread that runs ffprobe + ffmpeg
    # -----------------------------------------------------------------------

    class ExportWorker(QThread):
        """Background QThread that runs ffprobe then ffmpeg.

        Communicates with the main thread via *msg_queue*.  Message tuples:
          ('log', str)                   — informational text for status bar
          ('progress', float)            — progress percent 0–100
          ('indeterminate_step', None)   — advance indeterminate bar one step
          ('done', int, list[str])       — finished; returncode + stderr lines
          ('error', str)                 — pre-subprocess error
          ('cancelled', None)            — user cancelled
        """

        def __init__(
            self,
            input_path: str,
            output_path: str,
            start_s: float,
            duration_s_clip: float,
            reencode: bool,
            msg_queue: queue.Queue,
            scale_filter: str | None = None,
            crf: int = 18,
            audio_bitrate: str = "128k",
        ):
            super().__init__()
            self.input_path = input_path
            self.output_path = output_path
            self.start_s = start_s
            self.duration_s_clip = duration_s_clip
            self.reencode = reencode
            self.msg_queue = msg_queue
            self.scale_filter = scale_filter
            self.crf = crf
            self.audio_bitrate = audio_bitrate
            self._cancel_event = threading.Event()
            self._proc = None

        def cancel(self) -> None:
            """Signal the worker to stop after the current subprocess line."""
            self._cancel_event.set()

        def run(self) -> None:
            q = self.msg_queue
            cancel = self._cancel_event

            # --- probe input duration for determinate progress ---
            file_duration_s = None
            if self.reencode:
                q.put(("log", "Running ffprobe to read source duration..."))
                file_duration_s = self._probe(q)
                if file_duration_s == "ABORT":
                    return
                if cancel.is_set():
                    q.put(("cancelled", None))
                    return
                if file_duration_s is None:
                    q.put(("log",
                           "Could not read source duration; "
                           "progress bar will be indeterminate."))
                else:
                    # Duration for progress is the clip range, not the full file.
                    file_duration_s = min(
                        float(file_duration_s), self.duration_s_clip
                    )

            self._run_ffmpeg(file_duration_s, q, cancel)

        def _probe(self, q: queue.Queue):
            """Run ffprobe; return duration in seconds, None, or 'ABORT'."""
            cmd = [
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                self.input_path,
            ]
            try:
                result = subprocess.run(
                    cmd, capture_output=True, text=True, timeout=30
                )
                return parse_duration(result.stdout)
            except FileNotFoundError:
                q.put((
                    "error",
                    "ffprobe not found. Install ffmpeg package (includes ffprobe).\n"
                    "  sudo apt install ffmpeg",
                ))
                return "ABORT"
            except subprocess.TimeoutExpired:
                q.put(("error", "ffprobe timed out reading the file."))
                return "ABORT"

        def _run_ffmpeg(
            self,
            clip_duration_s,
            q: queue.Queue,
            cancel: threading.Event,
        ) -> None:
            """Build and run the ffmpeg command; relay progress messages."""
            if self.reencode:
                cmd = build_reencode_cmd(
                    self.input_path, self.output_path,
                    self.start_s, self.duration_s_clip,
                    scale_filter=self.scale_filter,
                    crf=self.crf,
                    audio_bitrate=self.audio_bitrate,
                )
            else:
                cmd = build_copy_cmd(
                    self.input_path, self.output_path,
                    self.start_s, self.duration_s_clip,
                )

            q.put(("log", "Starting ffmpeg...\n  " + " ".join(cmd)))

            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                self._proc = proc
            except FileNotFoundError:
                q.put((
                    "error",
                    "ffmpeg not found. Install it:\n  sudo apt install ffmpeg",
                ))
                return

            stderr_lines: list[str] = []

            def _read_stderr():
                for line in proc.stderr:
                    stderr_lines.append(line.rstrip())

            stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
            stderr_thread.start()

            for raw_line in proc.stdout:
                if cancel.is_set():
                    self._terminate()
                    break
                parsed = parse_progress_line(raw_line)
                if parsed is None:
                    continue
                key, value = parsed
                if key == "out_time_ms":
                    if clip_duration_s is not None and clip_duration_s > 0:
                        pct = progress_percent(value, clip_duration_s)
                        if pct is not None:
                            q.put(("progress", pct))
                    else:
                        q.put(("indeterminate_step", None))
                elif key == "progress" and value == "end":
                    if clip_duration_s is not None and clip_duration_s > 0:
                        q.put(("progress", 100.0))

            proc.wait()
            stderr_thread.join(timeout=5)

            if cancel.is_set():
                q.put(("cancelled", None))
                return

            q.put(("done", proc.returncode, stderr_lines))

        def _terminate(self) -> None:
            proc = self._proc
            if proc is None:
                return
            try:
                proc.terminate()
            except OSError:
                pass
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    proc.kill()
                except OSError:
                    pass

    # -----------------------------------------------------------------------
    # TimelineWidget — custom QPainter timeline with draggable handles
    # -----------------------------------------------------------------------

    class TimelineWidget(QWidget):
        """A custom timeline bar showing in-point, playhead, and out-point.

        Signals:
            in_point_changed(int)  — in-point dragged to new position (ms)
            out_point_changed(int) — out-point dragged to new position (ms)
            seek_requested(int)    — bar clicked or playhead dragged (ms)
        """

        in_point_changed = pyqtSignal(int)
        out_point_changed = pyqtSignal(int)
        seek_requested = pyqtSignal(int)

        _HIT_TOLERANCE = 8   # pixels within which a handle is "grabbed"
        _HANDLE_HEIGHT = 14  # half-height of the triangular handle

        def __init__(self, parent=None):
            super().__init__(parent)
            self._duration_ms: int = 0
            self._position_ms: int = 0
            self._in_ms: int = 0
            self._out_ms: int = 0
            self._drag: str | None = None  # 'in', 'out', 'playhead', or None
            self.setMinimumHeight(48)
            self.setMouseTracking(True)

        # --- Public setters ---

        def set_duration(self, ms: int) -> None:
            self._duration_ms = max(0, ms)
            self.update()

        def set_position(self, ms: int) -> None:
            self._position_ms = max(0, min(ms, self._duration_ms))
            self.update()

        def set_in_point(self, ms: int) -> None:
            self._in_ms = max(0, min(ms, self._duration_ms))
            self.update()

        def set_out_point(self, ms: int) -> None:
            self._out_ms = max(0, min(ms, self._duration_ms))
            self.update()

        # --- Coordinate helpers ---

        def _ms_to_x(self, ms: int) -> int:
            """Convert milliseconds to pixel X within the widget."""
            w = self.width()
            if self._duration_ms <= 0 or w <= 0:
                return 0
            return int(ms / self._duration_ms * w)

        def _x_to_ms(self, x: int) -> int:
            """Convert pixel X to milliseconds, clamped to [0, duration]."""
            w = self.width()
            if self._duration_ms <= 0 or w <= 0:
                return 0
            return max(0, min(int(x / w * self._duration_ms), self._duration_ms))

        def _nearest_handle(self, x: int) -> str | None:
            """Return which handle is within HIT_TOLERANCE of pixel x, or None."""
            candidates = {
                "in":       self._ms_to_x(self._in_ms),
                "out":      self._ms_to_x(self._out_ms),
                "playhead": self._ms_to_x(self._position_ms),
            }
            closest_name = None
            closest_dist = self._HIT_TOLERANCE + 1
            for name, hx in candidates.items():
                dist = abs(x - hx)
                if dist < closest_dist:
                    closest_dist = dist
                    closest_name = name
            return closest_name

        # --- Mouse events ---

        def mousePressEvent(self, event) -> None:
            if self._duration_ms <= 0:
                return
            x = event.position().x()
            handle = self._nearest_handle(int(x))
            if handle:
                self._drag = handle
            else:
                # Click on bar background — seek
                ms = self._x_to_ms(int(x))
                self.seek_requested.emit(ms)

        def mouseMoveEvent(self, event) -> None:
            if self._drag is None or self._duration_ms <= 0:
                return
            ms = self._x_to_ms(int(event.position().x()))
            if self._drag == "in":
                self._in_ms = min(ms, self._out_ms)
                self.in_point_changed.emit(self._in_ms)
                # Keep playhead from being left behind the in-point
                if self._position_ms <= self._in_ms:
                    self._position_ms = self._in_ms
                    self.seek_requested.emit(self._position_ms)
                self.update()
            elif self._drag == "out":
                self._out_ms = max(ms, self._in_ms)
                self.out_point_changed.emit(self._out_ms)
                self.update()
            elif self._drag == "playhead":
                self._position_ms = ms
                self.seek_requested.emit(ms)
                self.update()

        def mouseReleaseEvent(self, event) -> None:
            self._drag = None

        # --- Paint ---

        def paintEvent(self, event) -> None:
            p = QPainter(self)
            p.setRenderHint(QPainter.RenderHint.Antialiasing)

            w = self.width()
            h = self.height()
            bar_y = h // 2 - 6
            bar_h = 12

            # Background bar
            p.fillRect(0, bar_y, w, bar_h, QColor(50, 50, 50))

            if self._duration_ms > 0:
                # Clip region highlight (in -> out)
                x_in = self._ms_to_x(self._in_ms)
                x_out = self._ms_to_x(self._out_ms)
                if x_out > x_in:
                    p.fillRect(x_in, bar_y, x_out - x_in, bar_h,
                               QColor(0, 160, 120, 180))

                # In-point handle — green downward triangle above bar
                x_in_px = self._ms_to_x(self._in_ms)
                self._draw_handle(p, x_in_px, bar_y, QColor(0, 220, 100), "in")

                # Out-point handle — red downward triangle above bar
                x_out_px = self._ms_to_x(self._out_ms)
                self._draw_handle(p, x_out_px, bar_y, QColor(220, 60, 60), "out")

                # Playhead — thin vertical white line
                x_ph = self._ms_to_x(self._position_ms)
                pen = QPen(QColor(240, 240, 60))
                pen.setWidth(2)
                p.setPen(pen)
                p.drawLine(x_ph, 0, x_ph, h)

            p.end()

        def _draw_handle(
            self, p: QPainter, x: int, bar_top: int, color: QColor, kind: str
        ) -> None:
            """Draw a small filled rectangle handle at pixel x above the bar."""
            p.fillRect(x - 2, bar_top - self._HANDLE_HEIGHT,
                       4, self._HANDLE_HEIGHT, color)
            # Tiny arrow tip on the bar surface
            p.fillRect(x - 4, bar_top - 4, 8, 4, color)

    # -----------------------------------------------------------------------
    # ClipperWindow — main application window
    # -----------------------------------------------------------------------

    # State constants
    IDLE = "IDLE"
    LOADED = "LOADED"
    PLAYING = "PLAYING"
    PAUSED = "PAUSED"
    PREVIEWING = "PREVIEWING"
    EXPORTING = "EXPORTING"
    DONE = "DONE"
    ERROR = "ERROR"
    BATCH_RUNNING = "BATCH_RUNNING"

    class ClipperWindow(QMainWindow):
        """Main window for the Video Clipper utility."""

        def __init__(self):
            super().__init__()
            self.setWindowTitle("Video Clipper")
            self.setMinimumSize(640, 480)
            self.resize(1920, 1080)

            # Internal state
            self._state: str = IDLE
            self._input_path: str = ""
            self._in_ms: int = 0
            self._out_ms: int = 0
            self._duration_ms: int = 0
            self._output_dir: str = ""
            self._filename_dirty: bool = False
            self._worker: ExportWorker | None = None
            self._msg_queue: queue.Queue = queue.Queue()
            self._poll_timer: QTimer = QTimer(self)
            self._poll_timer.setInterval(100)
            self._poll_timer.timeout.connect(self._poll_worker_queue)
            self._preview_timer: QTimer | None = None

            self._batch_items: list = []
            self._batch_active: dict = {}   # {batch_item_index: (ExportWorker, queue.Queue)}
            self._batch_max_jobs: int = 1
            self._batch_timer = QTimer(self)
            self._batch_timer.setInterval(100)
            self._batch_timer.timeout.connect(self._poll_batch_queue)

            # Media player
            self._player = QMediaPlayer(self)
            self._audio_out = QAudioOutput(self)
            self._player.setAudioOutput(self._audio_out)
            self._audio_out.setVolume(1.0)

            # Build UI
            self._build_ui()
            self._wire_signals()
            self._set_state(IDLE)

        # ----------------------------------------------------------------
        # UI construction
        # ----------------------------------------------------------------

        def _build_ui(self) -> None:
            central = QWidget()
            self.setCentralWidget(central)
            root_layout = QVBoxLayout(central)
            root_layout.setSpacing(6)
            root_layout.setContentsMargins(8, 8, 8, 8)

            # --- File row ---
            file_row = QHBoxLayout()
            file_row.addWidget(QLabel("Input:"))
            self._input_edit = QLineEdit()
            self._input_edit.setReadOnly(True)
            self._input_edit.setPlaceholderText("No file loaded")
            file_row.addWidget(self._input_edit, 1)
            self._input_browse_btn = QPushButton("Browse...")
            self._input_browse_btn.clicked.connect(self._on_input_browse)
            file_row.addWidget(self._input_browse_btn)
            root_layout.addLayout(file_row)

            # --- Video widget ---
            self._video_widget = QVideoWidget()
            self._video_widget.setMinimumSize(480, 270)
            self._video_widget.setSizePolicy(
                QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding
            )
            self._player.setVideoOutput(self._video_widget)
            root_layout.addWidget(self._video_widget, 1)

            # --- Transport row ---
            transport_row = QHBoxLayout()
            transport_row.addStretch(1)

            _btn_size = QSize(36, 36)
            _icon_size = QSize(22, 22)

            style = QApplication.instance().style()

            self._play_pause_btn = QPushButton()
            self._play_pause_btn.setIcon(
                style.standardIcon(QStyle.StandardPixmap.SP_MediaPlay)
            )
            self._play_pause_btn.setFixedSize(_btn_size)
            self._play_pause_btn.setIconSize(_icon_size)
            transport_row.addWidget(self._play_pause_btn)

            self._pause_btn = QPushButton()
            self._pause_btn.setIcon(
                style.standardIcon(QStyle.StandardPixmap.SP_MediaPause)
            )
            self._pause_btn.setFixedSize(_btn_size)
            self._pause_btn.setIconSize(_icon_size)
            transport_row.addWidget(self._pause_btn)

            self._stop_btn = QPushButton()
            self._stop_btn.setIcon(
                style.standardIcon(QStyle.StandardPixmap.SP_MediaStop)
            )
            self._stop_btn.setFixedSize(_btn_size)
            self._stop_btn.setIconSize(_icon_size)
            transport_row.addWidget(self._stop_btn)

            transport_row.addStretch(1)
            self._time_label = QLabel("00:00:00.000 / 00:00:00.000")
            transport_row.addWidget(self._time_label)

            transport_row.addSpacing(16)

            self._mute_btn = QPushButton()
            self._mute_btn.setIcon(
                style.standardIcon(QStyle.StandardPixmap.SP_MediaVolume)
            )
            self._mute_btn.setFixedSize(_btn_size)
            self._mute_btn.setIconSize(_icon_size)
            self._mute_btn.setCheckable(True)
            self._mute_btn.setToolTip("Mute")
            transport_row.addWidget(self._mute_btn)

            self._volume_slider = QSlider(Qt.Orientation.Horizontal)
            self._volume_slider.setRange(0, 100)
            self._volume_slider.setValue(100)
            self._volume_slider.setFixedWidth(90)
            self._volume_slider.setToolTip("Volume")
            transport_row.addWidget(self._volume_slider)

            root_layout.addLayout(transport_row)

            # --- Timeline ---
            self._timeline = TimelineWidget()
            self._timeline.setFixedHeight(48)
            root_layout.addWidget(self._timeline)

            # --- In/Out controls row ---
            inout_row = QHBoxLayout()
            self._set_in_btn = QPushButton("Set In")
            inout_row.addWidget(self._set_in_btn)
            self._in_label = QLabel("In:  00:00:00.000")
            inout_row.addWidget(self._in_label)
            inout_row.addStretch(1)
            self._out_label = QLabel("Out:  00:00:00.000")
            inout_row.addWidget(self._out_label)
            self._set_out_btn = QPushButton("Set Out")
            inout_row.addWidget(self._set_out_btn)
            self._preview_btn = QPushButton("Preview")
            inout_row.addWidget(self._preview_btn)
            root_layout.addLayout(inout_row)

            # --- Output Dir row ---
            out_dir_row = QHBoxLayout()
            out_dir_row.addWidget(QLabel("Output Dir:"))
            self._out_dir_edit = QLineEdit()
            self._out_dir_edit.setPlaceholderText("Directory where clip will be saved")
            out_dir_row.addWidget(self._out_dir_edit, 1)
            self._out_dir_btn = QPushButton("Browse...")
            self._out_dir_btn.clicked.connect(self._on_output_dir_browse)
            out_dir_row.addWidget(self._out_dir_btn)
            root_layout.addLayout(out_dir_row)

            # --- Filename row ---
            out_name_row = QHBoxLayout()
            out_name_row.addWidget(QLabel("Filename:"))
            self._out_name_edit = QLineEdit()
            self._out_name_edit.setPlaceholderText("Select in/out points to auto-populate")
            self._out_name_edit.textEdited.connect(self._on_output_name_edited)
            out_name_row.addWidget(self._out_name_edit, 1)
            root_layout.addLayout(out_name_row)

            # --- Options row ---
            opt_row = QHBoxLayout()
            self._reencode_cb = QCheckBox("Frame-accurate (re-encode with libx264/AAC)")
            opt_row.addWidget(self._reencode_cb)
            opt_row.addStretch(1)
            root_layout.addLayout(opt_row)

            # --- Encode settings row ---
            encode_settings_row = QHBoxLayout()
            encode_settings_row.addWidget(QLabel("Preset:"))
            self._preset_combo = QComboBox()
            for p in EXPORT_PRESETS:
                self._preset_combo.addItem(p["label"])
            self._preset_combo.setCurrentIndex(0)
            self._preset_combo.setEnabled(False)
            encode_settings_row.addWidget(self._preset_combo)
            encode_settings_row.addWidget(QLabel("Resolution:"))
            self._resolution_combo = QComboBox()
            for r in RESOLUTION_OPTIONS:
                self._resolution_combo.addItem(r["label"])
            self._resolution_combo.setCurrentIndex(0)
            self._resolution_combo.setEnabled(False)
            encode_settings_row.addWidget(self._resolution_combo)
            encode_settings_row.addWidget(QLabel("CRF:"))
            self._crf_combo = QComboBox()
            for c in CRF_OPTIONS:
                self._crf_combo.addItem(c["label"])
            self._crf_combo.setCurrentIndex(0)
            self._crf_combo.setEnabled(False)
            encode_settings_row.addWidget(self._crf_combo)
            encode_settings_row.addStretch(1)
            root_layout.addLayout(encode_settings_row)

            # --- Batch queue panel ---
            self._build_batch_panel(root_layout)

            # --- Progress bar ---
            self._progress_bar = QProgressBar()
            self._progress_bar.setRange(0, 100)
            self._progress_bar.setValue(0)
            self._progress_bar.setVisible(False)
            root_layout.addWidget(self._progress_bar)

            # --- Export / Cancel buttons ---
            btn_row = QHBoxLayout()
            btn_row.addStretch(1)
            self._export_btn = QPushButton("Export")
            self._export_btn.clicked.connect(self._on_export)
            btn_row.addWidget(self._export_btn)
            self._cancel_btn = QPushButton("Cancel")
            self._cancel_btn.clicked.connect(self._on_cancel)
            btn_row.addWidget(self._cancel_btn)
            root_layout.addLayout(btn_row)

            # --- Status bar ---
            self._status_bar = QStatusBar()
            self.setStatusBar(self._status_bar)
            self._status_bar.showMessage("Ready.")

        # ----------------------------------------------------------------
        # Signal wiring
        # ----------------------------------------------------------------

        def _wire_signals(self) -> None:
            self._player.durationChanged.connect(self._on_duration_changed)
            self._player.positionChanged.connect(self._on_position_changed)
            self._player.playbackStateChanged.connect(self._on_playback_state)
            self._player.errorOccurred.connect(self._on_player_error)

            self._play_pause_btn.clicked.connect(self._on_play_pause)
            self._pause_btn.clicked.connect(self._player.pause)
            self._stop_btn.clicked.connect(self._on_stop)
            self._mute_btn.toggled.connect(self._on_mute_toggled)
            self._volume_slider.valueChanged.connect(self._on_volume_changed)
            self._set_in_btn.clicked.connect(self._on_set_in)
            self._set_out_btn.clicked.connect(self._on_set_out)
            self._preview_btn.clicked.connect(self._on_preview)

            self._timeline.seek_requested.connect(self._player.setPosition)
            self._timeline.in_point_changed.connect(self._on_in_changed)
            self._timeline.out_point_changed.connect(self._on_out_changed)

            self._reencode_cb.stateChanged.connect(self._on_reencode_toggled)
            self._preset_combo.currentIndexChanged.connect(self._on_preset_changed)

        # ----------------------------------------------------------------
        # Batch panel construction
        # ----------------------------------------------------------------

        def _build_batch_panel(self, root_layout) -> None:
            self._batch_group = QGroupBox("Batch Queue")
            self._batch_group.setCheckable(True)
            self._batch_group.setChecked(True)

            group_layout = QVBoxLayout(self._batch_group)

            container = QWidget()
            container_layout = QVBoxLayout(container)
            container_layout.setContentsMargins(0, 0, 0, 0)

            self._batch_table = QTableWidget(0, 5)
            self._batch_table.setHorizontalHeaderLabels(
                ["Source", "Range", "Output", "Status", "Progress"]
            )
            hh = self._batch_table.horizontalHeader()
            hh.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
            hh.setDefaultSectionSize(160)
            self._batch_table.setColumnWidth(0, 220)
            self._batch_table.setColumnWidth(1, 180)
            self._batch_table.setColumnWidth(2, 220)
            self._batch_table.setColumnWidth(3, 90)
            self._batch_table.setColumnWidth(4, 80)
            self._batch_table.setEditTriggers(
                QAbstractItemView.EditTrigger.NoEditTriggers
            )
            self._batch_table.setSelectionBehavior(
                QAbstractItemView.SelectionBehavior.SelectRows
            )
            self._batch_table.setSelectionMode(
                QAbstractItemView.SelectionMode.SingleSelection
            )
            self._batch_table.setFixedHeight(150)
            container_layout.addWidget(self._batch_table)

            btn_row = QHBoxLayout()
            self._add_to_batch_btn = QPushButton("Add to Batch")
            btn_row.addWidget(self._add_to_batch_btn)
            self._remove_batch_btn = QPushButton("Remove Selected")
            btn_row.addWidget(self._remove_batch_btn)
            self._requeue_batch_btn = QPushButton("Requeue Selected")
            btn_row.addWidget(self._requeue_batch_btn)
            self._batch_overall_label = QLabel("0 of 0 done")
            btn_row.addWidget(self._batch_overall_label)
            btn_row.addStretch(1)
            btn_row.addWidget(QLabel("Parallel jobs:"))
            self._batch_jobs_spin = QSpinBox()
            self._batch_jobs_spin.setRange(1, 4)
            self._batch_jobs_spin.setValue(1)
            btn_row.addWidget(self._batch_jobs_spin)
            self._run_batch_btn = QPushButton("Run Batch")
            btn_row.addWidget(self._run_batch_btn)
            self._cancel_batch_btn = QPushButton("Cancel Batch")
            btn_row.addWidget(self._cancel_batch_btn)
            container_layout.addLayout(btn_row)

            group_layout.addWidget(container)
            root_layout.addWidget(self._batch_group)

            self._add_to_batch_btn.clicked.connect(self._on_add_to_batch)
            self._remove_batch_btn.clicked.connect(self._on_remove_batch_item)
            self._requeue_batch_btn.clicked.connect(self._on_requeue_batch_item)
            self._run_batch_btn.clicked.connect(self._on_run_batch)
            self._cancel_batch_btn.clicked.connect(self._on_cancel_batch)
            self._batch_group.toggled.connect(
                lambda checked: container.setVisible(checked)
            )

        # ----------------------------------------------------------------
        # Batch queue operations
        # ----------------------------------------------------------------

        def _on_add_to_batch(self) -> None:
            inp = self._input_path
            out = self._full_output_path()
            reencode = self._reencode_cb.isChecked()
            if reencode:
                scale_filter = RESOLUTION_OPTIONS[self._resolution_combo.currentIndex()]["scale_filter"]
                crf = CRF_OPTIONS[self._crf_combo.currentIndex()]["crf"]
                audio_bitrate = EXPORT_PRESETS[self._preset_combo.currentIndex()]["audio_bitrate"]
            else:
                scale_filter = None
                crf = 18
                audio_bitrate = "128k"

            item, err = make_batch_item(
                inp, out, self._in_ms, self._out_ms,
                reencode, scale_filter, crf, audio_bitrate,
            )
            if err:
                self._status_bar.showMessage(f"Cannot add to batch: {err}")
                return

            self._batch_items.append(item)
            self._refresh_batch_table()
            self._update_batch_overall_label()
            self._status_bar.showMessage(
                f"Added to batch: {Path(item.input_path).name}"
                f" [{format_time(item.start_ms)} – {format_time(item.end_ms)}]"
            )
            self._set_state(self._state)

        def _on_remove_batch_item(self) -> None:
            row = self._batch_table.currentRow()
            if row == -1:
                return
            if self._batch_items[row].status == "Running":
                self._status_bar.showMessage("Cannot remove a running job.")
                return
            del self._batch_items[row]
            self._refresh_batch_table()
            self._update_batch_overall_label()
            self._set_state(self._state)

        def _on_requeue_batch_item(self) -> None:
            row = self._batch_table.currentRow()
            if row == -1:
                return
            item = self._batch_items[row]
            if item.status == "Running":
                self._status_bar.showMessage("Cannot requeue a running job.")
                return
            item.status = "Pending"
            item.progress = 0.0
            item.error_detail = ""
            self._refresh_batch_table()
            self._update_batch_overall_label()
            self._set_state(self._state)

        def _on_run_batch(self) -> None:
            pending = [i for i in self._batch_items if i.status == "Pending"]
            if not pending:
                self._status_bar.showMessage("No pending items in batch.")
                return
            self._batch_max_jobs = self._batch_jobs_spin.value()
            self._set_state(BATCH_RUNNING, "Batch running...")
            self._batch_timer.start()
            self._dispatch_next_batch_jobs()

        def _dispatch_next_batch_jobs(self) -> None:
            slots_free = self._batch_max_jobs - len(self._batch_active)
            while slots_free > 0:
                idx = next(
                    (i for i, it in enumerate(self._batch_items) if it.status == "Pending"),
                    None,
                )
                if idx is None:
                    break
                item = self._batch_items[idx]
                item.status = "Running"
                per_q: queue.Queue = queue.Queue()
                worker = ExportWorker(
                    input_path=item.input_path,
                    output_path=item.output_path,
                    start_s=item.start_ms / 1000.0,
                    duration_s_clip=(item.end_ms - item.start_ms) / 1000.0,
                    reencode=item.reencode,
                    msg_queue=per_q,
                    scale_filter=item.scale_filter,
                    crf=item.crf,
                    audio_bitrate=item.audio_bitrate,
                )
                worker.start()
                self._batch_active[idx] = (worker, per_q)
                slots_free -= 1
            self._refresh_batch_table()

        def _poll_batch_queue(self) -> None:
            for idx, (worker, per_q) in list(self._batch_active.items()):
                item = self._batch_items[idx]
                try:
                    while True:
                        msg = per_q.get_nowait()
                        kind = msg[0]
                        if kind == "log":
                            self._status_bar.showMessage(
                                f"[{Path(item.input_path).name}] {msg[1]}"
                            )
                        elif kind == "progress":
                            item.progress = float(msg[1])
                        elif kind == "indeterminate_step":
                            pass
                        elif kind == "done":
                            rc = msg[1]
                            stderr = msg[2]
                            if rc == 0:
                                item.status = "Done"
                            else:
                                item.status = "Error"
                                item.error_detail = "\n".join(stderr[-5:])
                            del self._batch_active[idx]
                            self._dispatch_next_batch_jobs()
                        elif kind == "error":
                            item.status = "Error"
                            item.error_detail = msg[1]
                            del self._batch_active[idx]
                            self._dispatch_next_batch_jobs()
                        elif kind == "cancelled":
                            item.status = "Cancelled"
                            delete_partial_output(item.output_path)
                            del self._batch_active[idx]
                            self._dispatch_next_batch_jobs()
                except queue.Empty:
                    pass

            self._refresh_batch_table()
            self._update_batch_overall_label()

            if not self._batch_active and not any(
                it.status == "Pending" for it in self._batch_items
            ):
                self._batch_timer.stop()
                done_count = sum(
                    1 for it in self._batch_items
                    if it.status in {"Done", "Error", "Cancelled"}
                )
                total = len(self._batch_items)
                self._set_state(
                    LOADED if self._input_path else IDLE,
                    f"Batch complete. {done_count}/{total} finished.",
                )

        def _on_cancel_batch(self) -> None:
            for worker, _ in self._batch_active.values():
                worker.cancel()
            for item in self._batch_items:
                if item.status == "Pending":
                    item.status = "Cancelled"
            self._cancel_batch_btn.setEnabled(False)
            self._status_bar.showMessage("Cancelling batch...")

        def _refresh_batch_table(self) -> None:
            self._batch_table.setRowCount(len(self._batch_items))
            for i, item in enumerate(self._batch_items):
                src, rng, out, status = batch_item_row_text(item)
                for col, text in enumerate([src, rng, out, status]):
                    cell = QTableWidgetItem(text)
                    cell.setFlags(
                        Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled
                    )
                    if col == 0:
                        cell.setToolTip(item.input_path)
                    elif col == 2:
                        cell.setToolTip(item.output_path)
                    self._batch_table.setItem(i, col, cell)
                progress_text = f"{item.progress:.0f}%" if item.status == "Running" else ""
                prog_cell = QTableWidgetItem(progress_text)
                prog_cell.setFlags(
                    Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled
                )
                self._batch_table.setItem(i, 4, prog_cell)

        def _update_batch_overall_label(self) -> None:
            done = sum(
                1 for it in self._batch_items
                if it.status in {"Done", "Error", "Cancelled"}
            )
            total = len(self._batch_items)
            self._batch_overall_label.setText(batch_progress_label(done, total))

        # ----------------------------------------------------------------
        # Encode settings handlers
        # ----------------------------------------------------------------

        def _on_reencode_toggled(self, state) -> None:
            self._set_state(self._state)

        def _on_preset_changed(self, index: int) -> None:
            preset = EXPORT_PRESETS[index]
            target_scale = preset["scale_filter"]
            target_crf = preset["crf"]

            res_idx = 0
            for i, r in enumerate(RESOLUTION_OPTIONS):
                if r["scale_filter"] == target_scale:
                    res_idx = i
                    break

            crf_idx = 0
            for i, c in enumerate(CRF_OPTIONS):
                if c["crf"] == target_crf:
                    crf_idx = i
                    break

            # blockSignals prevents cascade currentIndexChanged loops
            try:
                self._resolution_combo.blockSignals(True)
                self._crf_combo.blockSignals(True)
                self._resolution_combo.setCurrentIndex(res_idx)
                self._crf_combo.setCurrentIndex(crf_idx)
            finally:
                self._resolution_combo.blockSignals(False)
                self._crf_combo.blockSignals(False)

        # ----------------------------------------------------------------
        # State machine
        # ----------------------------------------------------------------

        def _set_state(self, state: str, message: str = "") -> None:
            self._state = state

            loaded = state not in (IDLE,)
            playing = state == PLAYING
            previewing = state == PREVIEWING
            exporting = state == EXPORTING
            batch_running = state == BATCH_RUNNING
            active = playing or previewing or exporting

            self._play_pause_btn.setEnabled(loaded and not exporting)
            self._pause_btn.setEnabled(loaded and (playing or previewing))
            self._stop_btn.setEnabled(loaded and not exporting)
            self._set_in_btn.setEnabled(loaded and not exporting)
            self._set_out_btn.setEnabled(loaded and not exporting)
            self._preview_btn.setEnabled(
                loaded and not exporting and self._out_ms > self._in_ms
            )
            self._input_browse_btn.setEnabled(not exporting and not batch_running)
            output_editable = not exporting
            self._out_dir_edit.setEnabled(output_editable)
            self._out_dir_btn.setEnabled(output_editable)
            self._out_name_edit.setEnabled(output_editable)
            self._reencode_cb.setEnabled(not exporting)
            encode_enabled = self._reencode_cb.isChecked() and not exporting
            self._preset_combo.setEnabled(encode_enabled)
            self._resolution_combo.setEnabled(encode_enabled)
            self._crf_combo.setEnabled(encode_enabled)

            can_export = (
                loaded
                and not active
                and not batch_running
                and self._out_ms > self._in_ms
            )
            self._export_btn.setEnabled(can_export and not batch_running)
            self._cancel_btn.setEnabled(exporting)

            self._add_to_batch_btn.setEnabled(can_export and not batch_running)
            self._run_batch_btn.setEnabled(not batch_running and bool(self._batch_items))
            self._cancel_batch_btn.setEnabled(batch_running)
            self._remove_batch_btn.setEnabled(not batch_running)
            self._requeue_batch_btn.setEnabled(not batch_running)
            self._batch_jobs_spin.setEnabled(not batch_running)

            if state in (EXPORTING, BATCH_RUNNING):
                self._progress_bar.setVisible(True)
                if state == EXPORTING:
                    if self._reencode_cb.isChecked():
                        # Determinate — reset to 0; progress messages will fill it
                        self._progress_bar.setRange(0, 100)
                        self._progress_bar.setValue(0)
                    else:
                        # Indeterminate for stream-copy
                        self._progress_bar.setRange(0, 0)
            elif state == DONE:
                self._progress_bar.setVisible(True)
                self._progress_bar.setRange(0, 100)
                self._progress_bar.setValue(100)
            elif state in (IDLE, LOADED, PAUSED, ERROR):
                self._progress_bar.setVisible(False)
                if self._progress_bar.maximum() == 0:
                    self._progress_bar.setRange(0, 100)

            if message:
                self._status_bar.showMessage(message)

        # ----------------------------------------------------------------
        # Player signal handlers
        # ----------------------------------------------------------------

        def _on_duration_changed(self, duration_ms: int) -> None:
            self._duration_ms = duration_ms
            self._timeline.set_duration(duration_ms)
            # Default out-point to end of file if not yet set
            if self._out_ms == 0 or self._out_ms > duration_ms:
                self._out_ms = duration_ms
                self._timeline.set_out_point(duration_ms)
                self._update_out_label()
            total = format_time(duration_ms)
            pos = format_time(self._player.position())
            self._time_label.setText(f"{pos} / {total}")
            self._set_state(LOADED)
            self._status_bar.showMessage(
                f"Loaded: {Path(self._input_path).name}  "
                f"({total})"
            )

        def _on_position_changed(self, position_ms: int) -> None:
            self._timeline.set_position(position_ms)
            total = format_time(self._duration_ms)
            pos = format_time(position_ms)
            self._time_label.setText(f"{pos} / {total}")

        def _on_playback_state(self, state) -> None:
            from PyQt6.QtMultimedia import QMediaPlayer as _QMP
            if state == _QMP.PlaybackState.PlayingState:
                if self._state != PREVIEWING:
                    self._set_state(PLAYING)
            else:
                if self._state == PLAYING:
                    self._set_state(PAUSED)

        def _on_player_error(self, _error, error_string: str) -> None:
            self._set_state(ERROR, f"Media error: {error_string}")

        # ----------------------------------------------------------------
        # Transport controls
        # ----------------------------------------------------------------

        def _on_play_pause(self) -> None:
            from PyQt6.QtMultimedia import QMediaPlayer as _QMP
            if self._player.playbackState() == _QMP.PlaybackState.PlayingState:
                self._player.pause()
            else:
                self._player.play()

        def _on_stop(self) -> None:
            self._player.stop()
            self._player.setPosition(self._in_ms)
            self._set_state(LOADED if self._input_path else IDLE)

        def _on_volume_changed(self, value: int) -> None:
            self._audio_out.setVolume(value / 100.0)
            if value == 0:
                self._mute_btn.setChecked(True)
            elif self._mute_btn.isChecked():
                self._mute_btn.setChecked(False)

        def _on_mute_toggled(self, muted: bool) -> None:
            style = QApplication.instance().style()
            icon_name = QStyle.StandardPixmap.SP_MediaVolumeMuted if muted else QStyle.StandardPixmap.SP_MediaVolume
            self._mute_btn.setIcon(style.standardIcon(icon_name))
            self._audio_out.setMuted(muted)

        # ----------------------------------------------------------------
        # In/Out point controls
        # ----------------------------------------------------------------

        def _on_set_in(self) -> None:
            ms = self._player.position()
            self._in_ms = ms
            self._timeline.set_in_point(ms)
            self._update_in_label()
            self._auto_populate_output()
            self._update_preview_btn()
            self._update_export_btn()

        def _on_set_out(self) -> None:
            ms = self._player.position()
            self._out_ms = ms
            self._timeline.set_out_point(ms)
            self._update_out_label()
            self._auto_populate_output()
            self._update_preview_btn()
            self._update_export_btn()

        def _on_in_changed(self, ms: int) -> None:
            self._in_ms = ms
            self._update_in_label()
            self._auto_populate_output()
            self._update_preview_btn()
            self._update_export_btn()

        def _on_out_changed(self, ms: int) -> None:
            self._out_ms = ms
            self._update_out_label()
            self._auto_populate_output()
            self._update_preview_btn()
            self._update_export_btn()

        def _update_in_label(self) -> None:
            self._in_label.setText(f"In:  {format_time(self._in_ms)}")

        def _update_out_label(self) -> None:
            self._out_label.setText(f"Out:  {format_time(self._out_ms)}")

        def _update_preview_btn(self) -> None:
            self._preview_btn.setEnabled(
                self._state not in (IDLE, EXPORTING)
                and self._out_ms > self._in_ms
            )

        def _update_export_btn(self) -> None:
            can = (
                self._state not in (IDLE, PLAYING, PREVIEWING, EXPORTING, BATCH_RUNNING)
                and self._out_ms > self._in_ms
            )
            self._export_btn.setEnabled(can)

        # ----------------------------------------------------------------
        # Input file browse
        # ----------------------------------------------------------------

        def _on_input_browse(self) -> None:
            path, _ = QFileDialog.getOpenFileName(
                self,
                "Select source video",
                "",
                "Video files (*.mp4 *.mkv *.avi *.mov *.flv *.wmv *.ts *.m2ts *.webm);;"
                "All files (*.*)",
            )
            if not path:
                return
            self._input_path = path
            self._input_edit.setText(path)
            self._in_ms = 0
            self._out_ms = 0
            self._filename_dirty = False
            # Seed the output dir from the input file's directory only if unset
            if not self._out_dir_edit.text():
                self._out_dir_edit.setText(str(Path(path).parent))
            self._timeline.set_in_point(0)
            self._timeline.set_out_point(0)
            self._update_in_label()
            self._update_out_label()
            self._player.setSource(QUrl.fromLocalFile(path))
            self._set_state(LOADED)

        # ----------------------------------------------------------------
        # Output dir browse, filename editing, auto-populate, full path
        # ----------------------------------------------------------------

        def _full_output_path(self) -> str:
            """Return the full output path from the dir + filename fields.

            Returns an empty string if either field is empty.
            """
            dir_text = self._out_dir_edit.text().strip()
            name_text = self._out_name_edit.text().strip()
            if not dir_text or not name_text:
                return ""
            return os.path.join(dir_text, name_text)

        def _on_output_dir_browse(self) -> None:
            initial = self._out_dir_edit.text() or ""
            directory = QFileDialog.getExistingDirectory(
                self,
                "Select output directory",
                initial,
            )
            if directory:
                self._out_dir_edit.setText(directory)

        def _on_output_name_edited(self, text: str) -> None:
            self._filename_dirty = True

        def _auto_populate_output(self) -> None:
            """Regenerate the filename field unless the user has manually edited it.

            Also seeds the output dir from the input file's directory if the dir
            field is currently empty.
            """
            if not self._input_path:
                return
            if self._out_ms <= self._in_ms:
                return
            if not self._out_dir_edit.text():
                self._out_dir_edit.setText(str(Path(self._input_path).parent))
            if not self._filename_dirty:
                filename = default_clip_filename(
                    self._input_path, self._in_ms, self._out_ms
                )
                self._out_name_edit.setText(filename)

        # ----------------------------------------------------------------
        # Preview
        # ----------------------------------------------------------------

        def _on_preview(self) -> None:
            if self._state in (EXPORTING,):
                return
            self._set_state(PREVIEWING)
            self._player.setPosition(self._in_ms)
            self._player.play()
            self._schedule_preview_poll()

        def _schedule_preview_poll(self) -> None:
            self._preview_timer = QTimer.singleShot(50, self._poll_preview)

        def _poll_preview(self) -> None:
            if self._state != PREVIEWING:
                return
            if self._player.position() >= self._out_ms:
                self._player.pause()
                self._set_state(PAUSED)
                self._status_bar.showMessage("Preview complete.")
            else:
                self._schedule_preview_poll()

        # ----------------------------------------------------------------
        # Export
        # ----------------------------------------------------------------

        def _on_export(self) -> None:
            if self._state == EXPORTING:
                return

            inp = self._input_path
            out = self._full_output_path()
            err = validate_export(inp, out, self._in_ms, self._out_ms)
            if err:
                self._status_bar.showMessage(f"Validation error: {err}")
                self._set_state(
                    LOADED if self._input_path else ERROR,
                    f"Validation error: {err}",
                )
                return

            start_s = self._in_ms / 1000.0
            duration_s_clip = (self._out_ms - self._in_ms) / 1000.0
            reencode = self._reencode_cb.isChecked()

            if reencode:
                scale_filter = RESOLUTION_OPTIONS[self._resolution_combo.currentIndex()]["scale_filter"]
                crf = CRF_OPTIONS[self._crf_combo.currentIndex()]["crf"]
                audio_bitrate = EXPORT_PRESETS[self._preset_combo.currentIndex()]["audio_bitrate"]
            else:
                scale_filter = None
                crf = 18
                audio_bitrate = "128k"

            # Clear queue from any prior run
            while not self._msg_queue.empty():
                try:
                    self._msg_queue.get_nowait()
                except queue.Empty:
                    break

            self._worker = ExportWorker(
                input_path=inp,
                output_path=out,
                start_s=start_s,
                duration_s_clip=duration_s_clip,
                reencode=reencode,
                msg_queue=self._msg_queue,
                scale_filter=scale_filter,
                crf=crf,
                audio_bitrate=audio_bitrate,
            )
            self._worker.start()
            self._poll_timer.start()
            self._set_state(EXPORTING, "Exporting...")

        def _on_cancel(self) -> None:
            if self._state != EXPORTING:
                return
            if self._worker:
                self._worker.cancel()
            self._cancel_btn.setEnabled(False)
            self._status_bar.showMessage("Cancelling...")

        # ----------------------------------------------------------------
        # Window close
        # ----------------------------------------------------------------

        def closeEvent(self, event) -> None:
            if self._worker:
                self._worker.cancel()
                self._worker.wait(3000)
            for worker, _ in self._batch_active.values():
                worker.cancel()
            for worker, _ in self._batch_active.values():
                worker.wait(3000)
            event.accept()

        # ----------------------------------------------------------------
        # Queue polling (QTimer tick)
        # ----------------------------------------------------------------

        def _poll_worker_queue(self) -> None:
            """Drain pending queue messages; stop timer when worker is done."""
            still_running = True
            try:
                while True:
                    msg = self._msg_queue.get_nowait()
                    kind = msg[0]

                    if kind == "log":
                        self._status_bar.showMessage(msg[1])

                    elif kind == "progress":
                        pct = float(msg[1])
                        # Switch from indeterminate to determinate if needed
                        if self._progress_bar.maximum() == 0:
                            self._progress_bar.setRange(0, 100)
                        self._progress_bar.setValue(int(pct))
                        self._status_bar.showMessage(f"Exporting... {pct:.0f}%")

                    elif kind == "indeterminate_step":
                        # Keep the indeterminate bar going (range is already 0,0)
                        pass

                    elif kind == "done":
                        rc = msg[1]
                        stderr_lines: list[str] = msg[2]
                        still_running = False
                        if rc == 0:
                            self._set_state(
                                DONE,
                                f"Exported to: {self._full_output_path()}",
                            )
                        else:
                            tail = "\n".join(stderr_lines[-10:])
                            self._set_state(
                                ERROR,
                                f"Export failed (exit {rc}). {tail[:200]}",
                            )

                    elif kind == "error":
                        self._set_state(ERROR, msg[1])
                        still_running = False

                    elif kind == "cancelled":
                        out_path = self._full_output_path()
                        delete_partial_output(out_path)
                        self._set_state(
                            LOADED if self._input_path else IDLE,
                            "Cancelled. Partial output deleted.",
                        )
                        still_running = False

            except queue.Empty:
                pass

            if not still_running:
                self._poll_timer.stop()
                self._worker = None

    # -----------------------------------------------------------------------
    # Application entry point
    # -----------------------------------------------------------------------

    app = QApplication(sys.argv)
    app.setApplicationName("Video Clipper")
    window = ClipperWindow()
    window.show()
    sys.exit(app.exec())


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    _build_gui()
