#!/usr/bin/env python3
"""MKV -> MP4 Converter.

Transcodes video files to H.264/AAC MP4 using ffmpeg.  Requires ffmpeg (which
includes ffprobe) to be installed and on PATH.

Run:
    python3 tools/mkv-convert/convert.py
"""

import json
import os
import queue
import subprocess
import threading
from pathlib import Path

# ---------------------------------------------------------------------------
# Pure / testable helpers — no Tkinter dependency
# ---------------------------------------------------------------------------

# Source video extensions shown in the file dialog filter.
INPUT_EXTENSIONS = [
    ("Video files", "*.mkv *.avi *.mov *.flv *.wmv *.ts *.m2ts *.mp4 *.webm"),
    ("All files", "*.*"),
]

# ffmpeg flags locked in by the plan (revision 1).
FFMPEG_FLAGS = [
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "18",
    "-c:a", "aac",
    "-b:a", "128k",
    "-map", "0:v:0",
    "-map", "0:a?",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    "-y",
]


def default_output_path(input_path: str) -> str:
    """Return the sibling .mp4 path for *input_path*.

    Example: /home/user/clip.mkv -> /home/user/clip.mp4
    """
    p = Path(input_path)
    return str(p.with_suffix(".mp4"))


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


def validate_preflight(input_path: str, output_path: str) -> str | None:
    """Run pre-flight validation before starting the worker thread.

    Returns an error message string on failure, or None on success.
    Checks (in order):
      1. Input non-empty.
      2. Input file exists.
      3. Input file is readable.
      4. Output non-empty.
      5. Output path differs from input path.
      6. Output directory exists and is writable.
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
    return None


def build_error_message(returncode: int, stderr_lines: list[str]) -> str:
    """Build the user-facing error message for a failed ffmpeg run."""
    tail = "\n".join(stderr_lines[-20:])
    msg = f"Conversion failed (exit {returncode}).\n{tail}"
    if any("Encoder libx264 not found" in line for line in stderr_lines):
        msg += (
            "\n\nHint: libx264 may not be compiled into your ffmpeg. "
            "Try: sudo apt install ffmpeg"
        )
    return msg


def delete_partial_output(output_path: str) -> None:
    """Remove *output_path* if it exists (called on cancel)."""
    try:
        p = Path(output_path)
        if p.exists():
            p.unlink()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Worker thread — runs ffprobe + ffmpeg off the main thread
# ---------------------------------------------------------------------------

class WorkerThread(threading.Thread):
    """Background thread that runs ffprobe then ffmpeg.

    Communicates with the main thread via *result_queue*.  Messages pushed:
      ('log', str)                   — informational text for the log area
      ('progress', float)            — progress percent 0–100
      ('indeterminate_step', None)   — advance indeterminate bar one step
      ('done', int, list[str])       — conversion finished; returncode + stderr
      ('error', str)                 — pre-subprocess error (file not found etc.)
      ('cancelled', None)            — user cancelled
    """

    def __init__(self, input_path: str, output_path: str,
                 result_queue: queue.Queue, cancel_event: threading.Event):
        super().__init__(daemon=True)
        self.input_path = input_path
        self.output_path = output_path
        self.result_queue = result_queue
        self.cancel_event = cancel_event
        self._proc = None  # ffmpeg Popen handle

    # ------------------------------------------------------------------
    def run(self):
        q = self.result_queue
        cancel = self.cancel_event

        # --- probe duration ---
        q.put(("log", "Running ffprobe to read duration..."))
        duration_s = self._probe(q)
        if cancel.is_set():
            self._on_cancel()
            return
        if duration_s is None:
            q.put(("log",
                   "Could not read duration. File may not be a valid media "
                   "file. Conversion will proceed with indeterminate progress."))

        # --- run ffmpeg ---
        self._convert(duration_s, q, cancel)

    # ------------------------------------------------------------------
    def _probe(self, q: queue.Queue) -> float | None:
        """Run ffprobe, return duration in seconds or None."""
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
            duration = parse_duration(result.stdout)
            return duration
        except FileNotFoundError:
            q.put(("error",
                   "ffprobe not found. Install ffmpeg package (includes ffprobe).\n"
                   "  sudo apt install ffmpeg"))
            return "ABORT"  # sentinel: probe failed fatally
        except subprocess.TimeoutExpired:
            q.put(("error", "ffprobe timed out reading the file."))
            return "ABORT"

    # ------------------------------------------------------------------
    def _convert(self, duration_s, q: queue.Queue, cancel: threading.Event):
        """Run ffmpeg and relay progress to *q*."""
        # Re-check abort sentinel from probe
        if duration_s == "ABORT":
            return

        cmd = (
            ["ffmpeg", "-i", self.input_path]
            + FFMPEG_FLAGS
            + [self.output_path]
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
            q.put(("error",
                   "ffmpeg not found. Install it:\n  sudo apt install ffmpeg"))
            return

        stderr_lines: list[str] = []

        # Read stderr in a side thread so it doesn't block stdout reads.
        def _read_stderr():
            for line in proc.stderr:
                stderr_lines.append(line.rstrip())

        stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
        stderr_thread.start()

        # Read stdout (progress lines) in the worker thread.
        for raw_line in proc.stdout:
            if cancel.is_set():
                self._terminate()
                break
            parsed = parse_progress_line(raw_line)
            if parsed is None:
                continue
            key, value = parsed
            if key == "out_time_ms":
                if duration_s is not None:
                    pct = progress_percent(value, duration_s)
                    if pct is not None:
                        q.put(("progress", pct))
                else:
                    q.put(("indeterminate_step", None))
            elif key == "progress" and value == "end":
                if duration_s is not None:
                    q.put(("progress", 100.0))

        proc.wait()
        stderr_thread.join(timeout=5)

        if cancel.is_set():
            self._on_cancel()
            return

        q.put(("done", proc.returncode, stderr_lines))

    # ------------------------------------------------------------------
    def _terminate(self):
        """Terminate the ffmpeg process gracefully, then forcefully."""
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

    # ------------------------------------------------------------------
    def _on_cancel(self):
        self.result_queue.put(("cancelled", None))


# ---------------------------------------------------------------------------
# Tkinter GUI — only imported when running as a script (not during unit tests)
# ---------------------------------------------------------------------------

def _build_gui():
    """Build and run the Tkinter application.  Import Tkinter here so that
    importing convert.py as a module in a headless test environment does not
    raise a TclError.
    """
    import tkinter as tk
    import tkinter.ttk as ttk
    import tkinter.filedialog as filedialog
    import tkinter.scrolledtext as scrolledtext

    # States
    IDLE = "IDLE"
    PROBING = "PROBING"
    CONVERTING = "CONVERTING"
    DONE = "DONE"
    ERROR = "ERROR"
    CANCELLED = "CANCELLED"

    class ConverterApp:
        def __init__(self, root: tk.Tk):
            self.root = root
            root.title("MKV -> MP4 Converter")
            root.minsize(480, 300)
            root.geometry("640x400")
            root.resizable(True, True)

            style = ttk.Style()
            style.theme_use("clam")

            self._state = IDLE
            self._result_queue: queue.Queue = queue.Queue()
            self._cancel_event = threading.Event()
            self._worker: WorkerThread | None = None
            # Track whether the output field has been manually overridden.
            self._output_manually_set = False
            self._last_auto_output = ""

            self._build_widgets()
            self._set_state(IDLE)

        # ------------------------------------------------------------------
        # Widget construction
        # ------------------------------------------------------------------
        def _build_widgets(self):
            root = self.root
            # Make column 1 (entry fields) grow with width.
            root.columnconfigure(1, weight=1)
            # Make row 3 (log area) grow with height.
            root.rowconfigure(3, weight=1)

            pad = {"padx": 8, "pady": 4}

            # --- Row 0: Source ---
            ttk.Label(root, text="Source video:").grid(
                row=0, column=0, sticky="e", **pad)
            self._input_var = tk.StringVar()
            self._input_var.trace_add("write", self._on_input_changed)
            self._input_entry = ttk.Entry(root, textvariable=self._input_var)
            self._input_entry.grid(row=0, column=1, sticky="ew", **pad)
            self._input_browse_btn = ttk.Button(
                root, text="Browse...", command=self._on_input_browse)
            self._input_browse_btn.grid(row=0, column=2, **pad)

            # --- Row 1: Output ---
            ttk.Label(root, text="Output file:").grid(
                row=1, column=0, sticky="e", **pad)
            self._output_var = tk.StringVar()
            self._output_var.trace_add("write", self._on_output_changed)
            self._output_entry = ttk.Entry(root, textvariable=self._output_var)
            self._output_entry.grid(row=1, column=1, sticky="ew", **pad)
            self._output_browse_btn = ttk.Button(
                root, text="Browse...", command=self._on_output_browse)
            self._output_browse_btn.grid(row=1, column=2, **pad)

            # --- Row 2: Progress bar + status ---
            progress_frame = ttk.Frame(root)
            progress_frame.grid(
                row=2, column=0, columnspan=3, sticky="ew", padx=8, pady=4)
            progress_frame.columnconfigure(0, weight=1)

            self._progress_bar = ttk.Progressbar(
                progress_frame, mode="determinate", maximum=100)
            self._progress_bar.grid(row=0, column=0, sticky="ew")

            self._status_label = ttk.Label(progress_frame, text="Ready.")
            self._status_label.grid(
                row=1, column=0, sticky="w", pady=(2, 0))

            # --- Row 3: Log area ---
            self._log_text = scrolledtext.ScrolledText(
                root, state="disabled", height=7, wrap="word",
                font=("Courier", 9))
            self._log_text.grid(
                row=3, column=0, columnspan=3, sticky="nsew", padx=8, pady=4)

            # --- Row 4: Buttons ---
            btn_frame = ttk.Frame(root)
            btn_frame.grid(
                row=4, column=0, columnspan=3, sticky="e", padx=8, pady=6)
            self._convert_btn = ttk.Button(
                btn_frame, text="Convert", command=self._on_convert)
            self._convert_btn.pack(side="left", padx=4)
            self._cancel_btn = ttk.Button(
                btn_frame, text="Cancel", command=self._on_cancel)
            self._cancel_btn.pack(side="left", padx=4)

        # ------------------------------------------------------------------
        # State machine
        # ------------------------------------------------------------------
        def _set_state(self, state: str, message: str = ""):
            self._state = state
            labels = {
                IDLE: "Ready.",
                PROBING: "Probing source file...",
                CONVERTING: "Converting...",
                DONE: "Done.",
                ERROR: "Error — see log below.",
                CANCELLED: "Cancelled.",
            }
            self._status_label.config(text=labels.get(state, state))
            if message:
                self._status_label.config(text=message)

            converting = state in (PROBING, CONVERTING)
            self._convert_btn.config(state="disabled" if converting else "normal")
            self._cancel_btn.config(state="normal" if converting else "disabled")
            self._input_browse_btn.config(
                state="disabled" if converting else "normal")
            self._output_browse_btn.config(
                state="disabled" if converting else "normal")
            self._input_entry.config(state="disabled" if converting else "normal")
            self._output_entry.config(state="disabled" if converting else "normal")

            if state == PROBING:
                self._progress_bar.config(mode="indeterminate", value=0)
                self._progress_bar.start(50)
            elif state == CONVERTING:
                self._progress_bar.stop()
                self._progress_bar.config(mode="determinate", value=0)
            elif state in (DONE, ERROR, CANCELLED, IDLE):
                self._progress_bar.stop()
                if state == DONE:
                    self._progress_bar.config(mode="determinate", value=100)
                elif state == IDLE:
                    self._progress_bar.config(mode="determinate", value=0)

        # ------------------------------------------------------------------
        # Log helpers
        # ------------------------------------------------------------------
        def _log_clear(self):
            self._log_text.config(state="normal")
            self._log_text.delete("1.0", "end")
            self._log_text.config(state="disabled")

        def _log_append(self, text: str):
            self._log_text.config(state="normal")
            self._log_text.insert("end", text + "\n")
            self._log_text.see("end")
            self._log_text.config(state="disabled")

        # ------------------------------------------------------------------
        # Input / output path handling
        # ------------------------------------------------------------------
        def _on_input_browse(self):
            path = filedialog.askopenfilename(
                title="Select source video",
                filetypes=INPUT_EXTENSIONS,
            )
            if path:
                self._input_var.set(path)

        def _on_output_browse(self):
            initial = self._output_var.get()
            initial_dir = str(Path(initial).parent) if initial else ""
            initial_file = Path(initial).name if initial else ""
            path = filedialog.asksaveasfilename(
                title="Save output as",
                defaultextension=".mp4",
                filetypes=[("MP4 video", "*.mp4"), ("All files", "*.*")],
                initialdir=initial_dir or None,
                initialfile=initial_file or None,
            )
            if path:
                self._output_manually_set = True
                self._output_var.set(path)

        def _on_input_changed(self, *_args):
            """Auto-populate output field unless it was manually overridden."""
            inp = self._input_var.get()
            if not inp:
                return
            auto = default_output_path(inp)
            # Reset the manual-override flag when the user changes the input
            # back to match the last auto-generated output (e.g. cleared it).
            current_out = self._output_var.get()
            if current_out == self._last_auto_output or not self._output_manually_set:
                self._output_manually_set = False
                self._last_auto_output = auto
                # Temporarily suspend the output-changed trace to avoid
                # incorrectly marking it as manually set.
                self._output_var.trace_remove(
                    "write",
                    self._output_var.trace_info()[0][1]
                    if self._output_var.trace_info() else "",
                )
                self._output_var.set(auto)
                # Re-add trace.
                self._output_var.trace_add("write", self._on_output_changed)

        def _on_output_changed(self, *_args):
            """Mark output as manually set when the user types in the field."""
            current = self._output_var.get()
            if current != self._last_auto_output:
                self._output_manually_set = True

        # ------------------------------------------------------------------
        # Convert / Cancel
        # ------------------------------------------------------------------
        def _on_convert(self):
            if self._state not in (IDLE, DONE, ERROR, CANCELLED):
                return
            inp = self._input_var.get().strip()
            out = self._output_var.get().strip()
            err = validate_preflight(inp, out)
            if err:
                self._log_clear()
                self._log_append(err)
                self._set_state(ERROR)
                return

            self._log_clear()
            self._cancel_event.clear()
            self._set_state(PROBING)

            self._worker = WorkerThread(inp, out, self._result_queue,
                                        self._cancel_event)
            self._worker.start()
            self.root.after(100, self._poll_queue)

        def _on_cancel(self):
            if self._state not in (PROBING, CONVERTING):
                return
            self._cancel_event.set()
            output_path = self._output_var.get().strip()
            # Clean up partial output after the worker acknowledges cancel.
            # We schedule cleanup — actual deletion happens in _poll_queue
            # when 'cancelled' sentinel arrives.
            self._pending_cancel_output = output_path

        # ------------------------------------------------------------------
        # Queue polling
        # ------------------------------------------------------------------
        def _poll_queue(self):
            """Drain all pending queue messages in one pass, then reschedule."""
            still_running = True
            try:
                while True:
                    msg = self._result_queue.get_nowait()
                    kind = msg[0]

                    if kind == "log":
                        self._log_append(msg[1])

                    elif kind == "progress":
                        pct = msg[1]
                        if self._state == PROBING:
                            self._set_state(CONVERTING)
                        self._progress_bar.config(value=pct)
                        self._status_label.config(
                            text=f"Converting... {pct:.0f}%")

                    elif kind == "indeterminate_step":
                        # Already in indeterminate mode from PROBING state.
                        pass

                    elif kind == "done":
                        returncode = msg[1]
                        stderr_lines = msg[2]
                        if returncode == 0:
                            self._set_state(DONE)
                            self._log_append(
                                f"Conversion complete -> {self._output_var.get()}")
                        else:
                            err_msg = build_error_message(returncode, stderr_lines)
                            self._set_state(ERROR)
                            self._log_append(err_msg)
                        still_running = False

                    elif kind == "error":
                        self._set_state(ERROR)
                        self._log_append(msg[1])
                        still_running = False

                    elif kind == "cancelled":
                        output = getattr(self, "_pending_cancel_output", "")
                        if output:
                            delete_partial_output(output)
                        self._set_state(CANCELLED)
                        self._log_append("Cancelled. Partial output deleted.")
                        still_running = False

            except queue.Empty:
                pass

            if still_running and self._state in (PROBING, CONVERTING):
                self.root.after(100, self._poll_queue)

    # ------------------------------------------------------------------
    root = tk.Tk()
    app = ConverterApp(root)  # noqa: F841
    root.mainloop()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    _build_gui()
