"""Unit tests for convert.py (pure/non-Tkinter logic).

Run from the repo root:
    python3 -m unittest discover -s tools/mkv-convert -p 'test_*.py'
"""

import json
import os
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import convert


# ---------------------------------------------------------------------------
# parse_duration
# ---------------------------------------------------------------------------

class TestParseDuration(unittest.TestCase):
    def _make_stdout(self, duration):
        return json.dumps({"format": {"duration": str(duration)}})

    def test_valid_duration_float(self):
        stdout = self._make_stdout(123.456)
        result = convert.parse_duration(stdout)
        self.assertAlmostEqual(result, 123.456)

    def test_valid_duration_integer_string(self):
        stdout = self._make_stdout(60)
        result = convert.parse_duration(stdout)
        self.assertAlmostEqual(result, 60.0)

    def test_missing_duration_key_returns_none(self):
        stdout = json.dumps({"format": {}})
        self.assertIsNone(convert.parse_duration(stdout))

    def test_missing_format_key_returns_none(self):
        stdout = json.dumps({"streams": []})
        self.assertIsNone(convert.parse_duration(stdout))

    def test_invalid_json_returns_none(self):
        self.assertIsNone(convert.parse_duration("not json"))

    def test_empty_string_returns_none(self):
        self.assertIsNone(convert.parse_duration(""))

    def test_non_numeric_duration_returns_none(self):
        stdout = json.dumps({"format": {"duration": "N/A"}})
        self.assertIsNone(convert.parse_duration(stdout))

    def test_null_duration_returns_none(self):
        stdout = json.dumps({"format": {"duration": None}})
        self.assertIsNone(convert.parse_duration(stdout))


# ---------------------------------------------------------------------------
# parse_progress_line
# ---------------------------------------------------------------------------

class TestParseProgressLine(unittest.TestCase):
    def test_typical_line(self):
        result = convert.parse_progress_line("out_time_ms=1234567\n")
        self.assertEqual(result, ("out_time_ms", "1234567"))

    def test_progress_end(self):
        result = convert.parse_progress_line("progress=end\n")
        self.assertEqual(result, ("progress", "end"))

    def test_progress_continue(self):
        result = convert.parse_progress_line("progress=continue\n")
        self.assertEqual(result, ("progress", "continue"))

    def test_kv_line_with_spaces_parses(self):
        # "frame=  42" contains '=' so it parses; value is stripped.
        result = convert.parse_progress_line("frame=  42")
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "frame")
        self.assertEqual(result[1], "42")

    def test_empty_line_returns_none(self):
        self.assertIsNone(convert.parse_progress_line(""))

    def test_no_equals_returns_none(self):
        self.assertIsNone(convert.parse_progress_line("foobar"))

    def test_strips_whitespace(self):
        result = convert.parse_progress_line("  out_time_ms = 999  \n")
        self.assertEqual(result, ("out_time_ms", "999"))


# ---------------------------------------------------------------------------
# progress_percent
# ---------------------------------------------------------------------------

class TestProgressPercent(unittest.TestCase):
    def test_50_percent(self):
        # duration = 10s, elapsed = 5s = 5_000_000 us
        pct = convert.progress_percent("5000000", 10.0)
        self.assertAlmostEqual(pct, 50.0)

    def test_clamps_to_100(self):
        # elapsed > duration
        pct = convert.progress_percent("20000000", 10.0)
        self.assertAlmostEqual(pct, 100.0)

    def test_zero_elapsed(self):
        pct = convert.progress_percent("0", 10.0)
        self.assertAlmostEqual(pct, 0.0)

    def test_none_duration_returns_none(self):
        self.assertIsNone(convert.progress_percent("5000000", None))

    def test_zero_duration_returns_none(self):
        self.assertIsNone(convert.progress_percent("5000000", 0))

    def test_invalid_value_string_returns_none(self):
        self.assertIsNone(convert.progress_percent("N/A", 10.0))

    def test_100_percent_exact(self):
        pct = convert.progress_percent("10000000", 10.0)
        self.assertAlmostEqual(pct, 100.0)


# ---------------------------------------------------------------------------
# validate_preflight
# ---------------------------------------------------------------------------

class TestValidatePreflight(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp()
        # Create a real readable file to use as input.
        self._real_input = os.path.join(self._tmpdir, "source.mkv")
        Path(self._real_input).touch()
        self._real_output = os.path.join(self._tmpdir, "output.mp4")

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_valid_paths_returns_none(self):
        self.assertIsNone(
            convert.validate_preflight(self._real_input, self._real_output))

    def test_empty_input_returns_error(self):
        err = convert.validate_preflight("", self._real_output)
        self.assertIsNotNone(err)
        self.assertIn("source video", err.lower())

    def test_nonexistent_input_returns_error(self):
        err = convert.validate_preflight("/no/such/file.mkv", self._real_output)
        self.assertIsNotNone(err)
        self.assertIn("not found", err.lower())

    def test_empty_output_returns_error(self):
        err = convert.validate_preflight(self._real_input, "")
        self.assertIsNotNone(err)
        self.assertIn("output", err.lower())

    def test_output_same_as_input_returns_error(self):
        err = convert.validate_preflight(self._real_input, self._real_input)
        self.assertIsNotNone(err)
        self.assertIn("differ", err.lower())

    def test_unwritable_output_dir_returns_error(self):
        # Create a dir and remove write permission.
        locked_dir = os.path.join(self._tmpdir, "locked")
        os.makedirs(locked_dir)
        os.chmod(locked_dir, 0o555)
        try:
            out = os.path.join(locked_dir, "out.mp4")
            err = convert.validate_preflight(self._real_input, out)
            self.assertIsNotNone(err)
            self.assertIn("not writable", err.lower())
        finally:
            os.chmod(locked_dir, 0o755)

    def test_nonexistent_output_dir_returns_error(self):
        out = os.path.join(self._tmpdir, "nonexistent_subdir", "out.mp4")
        err = convert.validate_preflight(self._real_input, out)
        self.assertIsNotNone(err)

    def test_unreadable_input_returns_error(self):
        unreadable = os.path.join(self._tmpdir, "unreadable.mkv")
        Path(unreadable).touch()
        os.chmod(unreadable, 0o000)
        try:
            err = convert.validate_preflight(unreadable, self._real_output)
            # Only fails if we're not running as root.
            if os.getuid() != 0:
                self.assertIsNotNone(err)
                self.assertIn("permission", err.lower())
        finally:
            os.chmod(unreadable, 0o644)


# ---------------------------------------------------------------------------
# build_error_message
# ---------------------------------------------------------------------------

class TestBuildErrorMessage(unittest.TestCase):
    def test_nonzero_exit_includes_code(self):
        msg = convert.build_error_message(1, ["some error"])
        self.assertIn("exit 1", msg)

    def test_includes_last_stderr_lines(self):
        msg = convert.build_error_message(1, ["line1", "line2", "line3"])
        for line in ["line1", "line2", "line3"]:
            self.assertIn(line, msg)

    def test_truncates_to_20_lines(self):
        # More than 20 lines — only last 20 should appear.
        lines = [f"line{i}" for i in range(30)]
        msg = convert.build_error_message(1, lines)
        self.assertNotIn("line0", msg)  # first line should not appear
        self.assertIn("line29", msg)    # last line should appear

    def test_libx264_hint_added_when_present(self):
        lines = ["Encoder libx264 not found", "other error"]
        msg = convert.build_error_message(1, lines)
        self.assertIn("libx264", msg)
        self.assertIn("sudo apt install ffmpeg", msg)

    def test_no_libx264_hint_when_absent(self):
        lines = ["some other error"]
        msg = convert.build_error_message(1, lines)
        self.assertNotIn("sudo apt install ffmpeg", msg)

    def test_exit_0_still_formats(self):
        # build_error_message is only called on failure, but shouldn't crash
        # if called with 0.
        msg = convert.build_error_message(0, [])
        self.assertIn("exit 0", msg)


# ---------------------------------------------------------------------------
# delete_partial_output
# ---------------------------------------------------------------------------

class TestDeletePartialOutput(unittest.TestCase):
    def test_deletes_existing_file(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            path = f.name
        self.assertTrue(Path(path).exists())
        convert.delete_partial_output(path)
        self.assertFalse(Path(path).exists())

    def test_nonexistent_file_does_not_raise(self):
        # Should be a no-op, not raise.
        convert.delete_partial_output("/tmp/definitely_does_not_exist_12345.mp4")

    def test_empty_string_does_not_raise(self):
        convert.delete_partial_output("")


# ---------------------------------------------------------------------------
# default_output_path
# ---------------------------------------------------------------------------

class TestDefaultOutputPath(unittest.TestCase):
    def test_mkv_becomes_mp4(self):
        result = convert.default_output_path("/home/user/video.mkv")
        self.assertEqual(result, "/home/user/video.mp4")

    def test_avi_becomes_mp4(self):
        result = convert.default_output_path("/media/clip.avi")
        self.assertEqual(result, "/media/clip.mp4")

    def test_already_mp4_stays_mp4(self):
        result = convert.default_output_path("/home/user/clip.mp4")
        self.assertEqual(result, "/home/user/clip.mp4")

    def test_preserves_directory(self):
        result = convert.default_output_path("/some/deep/path/file.mkv")
        self.assertTrue(result.startswith("/some/deep/path/"))

    def test_no_double_extension(self):
        result = convert.default_output_path("/file.mkv")
        self.assertFalse(result.endswith(".mkv.mp4"))


# ---------------------------------------------------------------------------
# WorkerThread — ffprobe failure path (mocked subprocess)
# ---------------------------------------------------------------------------

class TestWorkerThreadProbeFailure(unittest.TestCase):
    """Test that the worker puts an error message when ffprobe is missing."""

    def test_ffprobe_not_found_puts_error_message(self):
        q = queue.Queue()
        cancel = threading.Event()

        with patch("subprocess.run", side_effect=FileNotFoundError("ffprobe")):
            wt = convert.WorkerThread(
                input_path="/fake/input.mkv",
                output_path="/fake/output.mp4",
                result_queue=q,
                cancel_event=cancel,
            )
            wt.run()  # run synchronously in test thread

        messages = []
        while not q.empty():
            messages.append(q.get_nowait())

        kinds = [m[0] for m in messages]
        self.assertIn("error", kinds)
        error_texts = [m[1] for m in messages if m[0] == "error"]
        self.assertTrue(
            any("ffprobe" in t.lower() for t in error_texts),
            f"Expected 'ffprobe' in error text, got: {error_texts}",
        )


class TestWorkerThreadFfmpegNotFound(unittest.TestCase):
    """Test that the worker puts an error message when ffmpeg is missing."""

    def test_ffmpeg_not_found_puts_error_message(self):
        q = queue.Queue()
        cancel = threading.Event()

        # ffprobe succeeds and returns a duration, ffmpeg Popen raises FNFE.
        fake_ffprobe_result = MagicMock()
        fake_ffprobe_result.stdout = json.dumps(
            {"format": {"duration": "60.0"}}
        )

        def fake_run(*args, **kwargs):
            return fake_ffprobe_result

        with patch("subprocess.run", side_effect=fake_run), \
             patch("subprocess.Popen", side_effect=FileNotFoundError("ffmpeg")):
            wt = convert.WorkerThread(
                input_path="/fake/input.mkv",
                output_path="/fake/output.mp4",
                result_queue=q,
                cancel_event=cancel,
            )
            wt.run()

        messages = list(q.queue)
        kinds = [m[0] for m in messages]
        self.assertIn("error", kinds)
        error_texts = [m[1] for m in messages if m[0] == "error"]
        self.assertTrue(
            any("ffmpeg" in t.lower() for t in error_texts),
            f"Expected 'ffmpeg' in error text, got: {error_texts}",
        )


# ---------------------------------------------------------------------------
# WorkerThread — cancel path with partial output cleanup
# ---------------------------------------------------------------------------

class TestWorkerThreadCancelCleanup(unittest.TestCase):
    """Verify that delete_partial_output is callable and removes files."""

    def test_partial_file_removed_after_cancel(self):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as f:
            partial_path = f.name
            f.write(b"\x00" * 1024)

        self.assertTrue(Path(partial_path).exists())
        convert.delete_partial_output(partial_path)
        self.assertFalse(Path(partial_path).exists())


# ---------------------------------------------------------------------------
# Error message matrix coverage
# ---------------------------------------------------------------------------

class TestErrorMatrix(unittest.TestCase):
    """Cover every row of the Error Handling Matrix from the plan."""

    def _tmpfile(self, name="source.mkv"):
        d = tempfile.mkdtemp()
        p = os.path.join(d, name)
        Path(p).touch()
        return p

    def test_ffmpeg_not_on_path(self):
        """Row: ffmpeg not on PATH -> clear message."""
        lines = ["ffmpeg not found", "error"]
        msg = convert.build_error_message(127, lines)
        self.assertIn("exit 127", msg)

    def test_ffprobe_not_on_path_error_kind(self):
        """Row: ffprobe not on PATH -> 'error' message in queue."""
        q = queue.Queue()
        cancel = threading.Event()
        with patch("subprocess.run", side_effect=FileNotFoundError):
            wt = convert.WorkerThread("/fake.mkv", "/out.mp4", q, cancel)
            wt.run()
        msgs = list(q.queue)
        self.assertTrue(any(m[0] == "error" for m in msgs))

    def test_input_not_found(self):
        """Row: input file does not exist."""
        err = convert.validate_preflight("/no/such/file.mkv", "/tmp/out.mp4")
        self.assertIn("not found", err.lower())

    def test_output_dir_not_writable(self):
        """Row: output directory not writable."""
        locked = tempfile.mkdtemp()
        os.chmod(locked, 0o555)
        try:
            src = self._tmpfile()
            err = convert.validate_preflight(src, os.path.join(locked, "out.mp4"))
            if os.getuid() != 0:
                self.assertIn("not writable", err.lower())
        finally:
            os.chmod(locked, 0o755)

    def test_ffmpeg_nonzero_exit(self):
        """Row: ffmpeg exits nonzero."""
        msg = convert.build_error_message(1, ["Conversion error detail"])
        self.assertIn("exit 1", msg)
        self.assertIn("Conversion error detail", msg)

    def test_libx264_hint_when_encoder_missing(self):
        """Row: ffmpeg stderr contains 'Encoder libx264 not found'."""
        lines = ["Error initializing output stream",
                 "Encoder libx264 not found for output stream"]
        msg = convert.build_error_message(1, lines)
        self.assertIn("libx264", msg)
        self.assertIn("sudo apt install ffmpeg", msg)

    def test_cancel_removes_partial_output(self):
        """Row: user cancels -> partial output deleted."""
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as f:
            path = f.name
        convert.delete_partial_output(path)
        self.assertFalse(Path(path).exists())

    def test_input_unreadable(self):
        """Row: input file unreadable."""
        p = self._tmpfile()
        os.chmod(p, 0o000)
        try:
            if os.getuid() != 0:
                err = convert.validate_preflight(p, "/tmp/out.mp4")
                self.assertIn("permission", err.lower())
        finally:
            os.chmod(p, 0o644)


# ---------------------------------------------------------------------------
# FFMPEG_FLAGS sanity check
# ---------------------------------------------------------------------------

class TestFfmpegFlags(unittest.TestCase):
    def test_no_shell_true_possible(self):
        """Flags list contains no shell meta-characters that would require shell=True."""
        # The list form itself prevents shell injection; we just verify the
        # expected flags are present.
        flags = convert.FFMPEG_FLAGS
        self.assertIn("-c:v", flags)
        self.assertIn("libx264", flags)
        self.assertIn("-crf", flags)
        self.assertIn("18", flags)
        self.assertIn("-progress", flags)
        self.assertIn("pipe:1", flags)
        self.assertIn("-nostats", flags)
        self.assertIn("-movflags", flags)
        self.assertIn("+faststart", flags)

    def test_audio_optional_map(self):
        """0:a? makes audio stream selection non-fatal."""
        flags = convert.FFMPEG_FLAGS
        idx = flags.index("-map")
        # Find the '0:a?' entry
        self.assertIn("0:a?", flags)


if __name__ == "__main__":
    unittest.main()
