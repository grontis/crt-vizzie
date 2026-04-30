"""Unit tests for clip.py (pure/non-Qt helpers).

Run from the repo root:
    python3 -m unittest discover -s tools/video-clipper -p 'test_*.py' -v
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

import clip


# ---------------------------------------------------------------------------
# format_time
# ---------------------------------------------------------------------------

class TestFormatTime(unittest.TestCase):
    def test_zero(self):
        self.assertEqual(clip.format_time(0), "00:00:00.000")

    def test_one_second(self):
        self.assertEqual(clip.format_time(1000), "00:00:01.000")

    def test_one_minute(self):
        self.assertEqual(clip.format_time(60_000), "00:01:00.000")

    def test_one_hour(self):
        self.assertEqual(clip.format_time(3_600_000), "01:00:00.000")

    def test_mixed_hms_and_millis(self):
        # 1h 1m 1s 1ms = 3661001 ms
        self.assertEqual(clip.format_time(3_661_001), "01:01:01.001")

    def test_millis_only(self):
        self.assertEqual(clip.format_time(500), "00:00:00.500")

    def test_large_hours(self):
        # 10 hours
        self.assertEqual(clip.format_time(36_000_000), "10:00:00.000")

    def test_negative_clamped_to_zero(self):
        self.assertEqual(clip.format_time(-100), "00:00:00.000")

    def test_float_truncated(self):
        # Float input should not raise; converted via int()
        self.assertEqual(clip.format_time(1500), "00:00:01.500")


# ---------------------------------------------------------------------------
# default_clip_output
# ---------------------------------------------------------------------------

class TestDefaultClipOutput(unittest.TestCase):
    def test_contains_clip_tag(self):
        result = clip.default_clip_output("/home/user/video.mp4", 1000, 5000)
        self.assertIn("_clip_", result)

    def test_output_is_mp4(self):
        result = clip.default_clip_output("/home/user/video.mp4", 0, 3000)
        self.assertTrue(result.endswith(".mp4"))

    def test_stem_preserved(self):
        result = clip.default_clip_output("/home/user/myvideo.mkv", 0, 1000)
        self.assertIn("myvideo", result)

    def test_sibling_directory(self):
        result = clip.default_clip_output("/some/path/vid.mp4", 1000, 2000)
        self.assertTrue(result.startswith("/some/path/"))

    def test_start_end_in_name(self):
        result = clip.default_clip_output("/a/b.mp4", 1000, 2500)
        self.assertIn("1000", result)
        self.assertIn("2500", result)

    def test_no_double_extension(self):
        result = clip.default_clip_output("/a/b.mkv", 0, 1000)
        self.assertFalse(result.endswith(".mkv.mp4"))
        self.assertTrue(result.endswith(".mp4"))

    def test_mkv_input_gives_mp4_output(self):
        result = clip.default_clip_output("/a/video.mkv", 0, 1000)
        self.assertTrue(result.endswith(".mp4"))

    def test_zero_start(self):
        result = clip.default_clip_output("/a/b.mp4", 0, 5000)
        self.assertIn("0", result)


# ---------------------------------------------------------------------------
# default_clip_filename
# ---------------------------------------------------------------------------

class TestDefaultClipFilename(unittest.TestCase):
    def test_normal_case(self):
        result = clip.default_clip_filename("/home/user/video.mp4", 5000, 30000)
        self.assertEqual(result, "video_0m05s-0m30s.mp4")

    def test_zero_in_point(self):
        result = clip.default_clip_filename("/a/b.mp4", 0, 90000)
        self.assertEqual(result, "b_0m00s-1m30s.mp4")

    def test_sub_second_duration_truncated_to_seconds(self):
        # Milliseconds within the same second — only whole seconds are encoded
        result = clip.default_clip_filename("/a/b.mp4", 5500, 30800)
        self.assertEqual(result, "b_0m05s-0m30s.mp4")

    def test_different_extension_stem_preserved(self):
        result = clip.default_clip_filename("/a/clip.mkv", 60000, 120000)
        self.assertEqual(result, "clip_1m00s-2m00s.mp4")

    def test_always_mp4_output(self):
        result = clip.default_clip_filename("/a/video.webm", 0, 5000)
        self.assertTrue(result.endswith(".mp4"))

    def test_no_directory_in_result(self):
        result = clip.default_clip_filename("/some/deep/path/myvideo.mp4", 0, 5000)
        self.assertNotIn("/", result)

    def test_minutes_zero_padded_seconds(self):
        # 1 minute 5 seconds in = 65000 ms
        result = clip.default_clip_filename("/a/v.mp4", 65000, 125000)
        self.assertEqual(result, "v_1m05s-2m05s.mp4")

    def test_large_in_point(self):
        # 1h 30m in-point = 5400000 ms
        result = clip.default_clip_filename("/a/movie.mp4", 5400000, 5460000)
        self.assertEqual(result, "movie_90m00s-91m00s.mp4")


# ---------------------------------------------------------------------------
# build_copy_cmd
# ---------------------------------------------------------------------------

class TestBuildCopyCmd(unittest.TestCase):
    def setUp(self):
        self.cmd = clip.build_copy_cmd(
            "/in/file.mp4", "/out/clip.mp4", 10.5, 30.0
        )

    def test_starts_with_ffmpeg(self):
        self.assertEqual(self.cmd[0], "ffmpeg")

    def test_ss_before_i(self):
        ss_idx = self.cmd.index("-ss")
        i_idx = self.cmd.index("-i")
        self.assertLess(ss_idx, i_idx)

    def test_ss_value(self):
        ss_idx = self.cmd.index("-ss")
        self.assertEqual(self.cmd[ss_idx + 1], "10.5")

    def test_has_to(self):
        self.assertIn("-to", self.cmd)
        to_idx = self.cmd.index("-to")
        self.assertEqual(self.cmd[to_idx + 1], "30.0")

    def test_c_copy(self):
        self.assertIn("-c", self.cmd)
        c_idx = self.cmd.index("-c")
        self.assertEqual(self.cmd[c_idx + 1], "copy")

    def test_no_libx264(self):
        self.assertNotIn("libx264", self.cmd)

    def test_no_shell_true(self):
        # All args must be strings (list form prevents shell injection)
        for arg in self.cmd:
            self.assertIsInstance(arg, str)

    def test_has_progress(self):
        self.assertIn("-progress", self.cmd)
        self.assertIn("pipe:1", self.cmd)

    def test_has_y_flag(self):
        self.assertIn("-y", self.cmd)

    def test_output_last(self):
        self.assertEqual(self.cmd[-1], "/out/clip.mp4")


# ---------------------------------------------------------------------------
# build_reencode_cmd
# ---------------------------------------------------------------------------

class TestBuildReencodeCmd(unittest.TestCase):
    def setUp(self):
        self.cmd = clip.build_reencode_cmd(
            "/in/file.mp4", "/out/clip.mp4", 10.5, 30.0
        )

    def test_starts_with_ffmpeg(self):
        self.assertEqual(self.cmd[0], "ffmpeg")

    def test_has_libx264(self):
        self.assertIn("libx264", self.cmd)

    def test_has_crf(self):
        self.assertIn("-crf", self.cmd)
        crf_idx = self.cmd.index("-crf")
        self.assertEqual(self.cmd[crf_idx + 1], "18")

    def test_has_aac(self):
        self.assertIn("-c:a", self.cmd)
        ca_idx = self.cmd.index("-c:a")
        self.assertEqual(self.cmd[ca_idx + 1], "aac")

    def test_ss_before_i(self):
        ss_idx = self.cmd.index("-ss")
        i_idx = self.cmd.index("-i")
        self.assertLess(ss_idx, i_idx)

    def test_has_to(self):
        self.assertIn("-to", self.cmd)

    def test_no_stream_copy(self):
        # Should not use bare -c copy
        copy_indices = [i for i, x in enumerate(self.cmd) if x == "-c"]
        for idx in copy_indices:
            self.assertNotEqual(self.cmd[idx + 1], "copy")

    def test_has_progress(self):
        self.assertIn("-progress", self.cmd)

    def test_has_y_flag(self):
        self.assertIn("-y", self.cmd)

    def test_output_last(self):
        self.assertEqual(self.cmd[-1], "/out/clip.mp4")


# ---------------------------------------------------------------------------
# validate_export
# ---------------------------------------------------------------------------

class TestValidateExport(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp()
        self._real_input = os.path.join(self._tmpdir, "source.mp4")
        Path(self._real_input).touch()
        self._real_output = os.path.join(self._tmpdir, "output.mp4")

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _ok(self):
        return clip.validate_export(
            self._real_input, self._real_output, 0, 5000
        )

    def test_valid_returns_none(self):
        self.assertIsNone(self._ok())

    def test_empty_input_returns_error(self):
        err = clip.validate_export("", self._real_output, 0, 5000)
        self.assertIsNotNone(err)
        self.assertIn("source", err.lower())

    def test_nonexistent_input_returns_error(self):
        err = clip.validate_export("/no/such/file.mp4", self._real_output, 0, 5000)
        self.assertIsNotNone(err)
        self.assertIn("not found", err.lower())

    def test_empty_output_returns_error(self):
        err = clip.validate_export(self._real_input, "", 0, 5000)
        self.assertIsNotNone(err)
        self.assertIn("output", err.lower())

    def test_output_same_as_input_returns_error(self):
        err = clip.validate_export(
            self._real_input, self._real_input, 0, 5000
        )
        self.assertIsNotNone(err)
        self.assertIn("differ", err.lower())

    def test_nonexistent_output_dir_returns_error(self):
        out = os.path.join(self._tmpdir, "nonexistent", "out.mp4")
        err = clip.validate_export(self._real_input, out, 0, 5000)
        self.assertIsNotNone(err)
        self.assertIn("not exist", err.lower())

    def test_unwritable_output_dir_returns_error(self):
        locked_dir = os.path.join(self._tmpdir, "locked")
        os.makedirs(locked_dir)
        os.chmod(locked_dir, 0o555)
        try:
            out = os.path.join(locked_dir, "out.mp4")
            err = clip.validate_export(self._real_input, out, 0, 5000)
            if os.getuid() != 0:
                self.assertIsNotNone(err)
                self.assertIn("not writable", err.lower())
        finally:
            os.chmod(locked_dir, 0o755)

    def test_negative_start_ms_returns_error(self):
        err = clip.validate_export(self._real_input, self._real_output, -1, 5000)
        self.assertIsNotNone(err)
        self.assertIn(">= 0", err)

    def test_end_equals_start_returns_error(self):
        err = clip.validate_export(self._real_input, self._real_output, 1000, 1000)
        self.assertIsNotNone(err)
        self.assertIn("after", err.lower())

    def test_end_before_start_returns_error(self):
        err = clip.validate_export(self._real_input, self._real_output, 5000, 1000)
        self.assertIsNotNone(err)

    def test_duration_under_100ms_returns_error(self):
        # 50 ms clip
        err = clip.validate_export(self._real_input, self._real_output, 1000, 1050)
        self.assertIsNotNone(err)
        self.assertIn("100 ms", err)

    def test_exactly_100ms_is_valid(self):
        err = clip.validate_export(self._real_input, self._real_output, 1000, 1100)
        self.assertIsNone(err)

    def test_unreadable_input_returns_error(self):
        unreadable = os.path.join(self._tmpdir, "unreadable.mp4")
        Path(unreadable).touch()
        os.chmod(unreadable, 0o000)
        try:
            if os.getuid() != 0:
                err = clip.validate_export(unreadable, self._real_output, 0, 5000)
                self.assertIsNotNone(err)
                self.assertIn("permission", err.lower())
        finally:
            os.chmod(unreadable, 0o644)


# ---------------------------------------------------------------------------
# parse_duration
# ---------------------------------------------------------------------------

class TestParseDuration(unittest.TestCase):
    def _make_stdout(self, duration):
        return json.dumps({"format": {"duration": str(duration)}})

    def test_valid_float(self):
        stdout = self._make_stdout(123.456)
        self.assertAlmostEqual(clip.parse_duration(stdout), 123.456)

    def test_valid_integer_string(self):
        stdout = self._make_stdout(60)
        self.assertAlmostEqual(clip.parse_duration(stdout), 60.0)

    def test_missing_duration_key_returns_none(self):
        stdout = json.dumps({"format": {}})
        self.assertIsNone(clip.parse_duration(stdout))

    def test_missing_format_key_returns_none(self):
        stdout = json.dumps({"streams": []})
        self.assertIsNone(clip.parse_duration(stdout))

    def test_invalid_json_returns_none(self):
        self.assertIsNone(clip.parse_duration("not json"))

    def test_empty_string_returns_none(self):
        self.assertIsNone(clip.parse_duration(""))

    def test_non_numeric_duration_returns_none(self):
        stdout = json.dumps({"format": {"duration": "N/A"}})
        self.assertIsNone(clip.parse_duration(stdout))

    def test_null_duration_returns_none(self):
        stdout = json.dumps({"format": {"duration": None}})
        self.assertIsNone(clip.parse_duration(stdout))


# ---------------------------------------------------------------------------
# parse_progress_line
# ---------------------------------------------------------------------------

class TestParseProgressLine(unittest.TestCase):
    def test_typical_line(self):
        result = clip.parse_progress_line("out_time_ms=1234567\n")
        self.assertEqual(result, ("out_time_ms", "1234567"))

    def test_progress_end(self):
        result = clip.parse_progress_line("progress=end\n")
        self.assertEqual(result, ("progress", "end"))

    def test_progress_continue(self):
        result = clip.parse_progress_line("progress=continue\n")
        self.assertEqual(result, ("progress", "continue"))

    def test_kv_with_spaces(self):
        result = clip.parse_progress_line("frame=  42")
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "frame")
        self.assertEqual(result[1], "42")

    def test_empty_line_returns_none(self):
        self.assertIsNone(clip.parse_progress_line(""))

    def test_no_equals_returns_none(self):
        self.assertIsNone(clip.parse_progress_line("foobar"))

    def test_strips_whitespace(self):
        result = clip.parse_progress_line("  out_time_ms = 999  \n")
        self.assertEqual(result, ("out_time_ms", "999"))


# ---------------------------------------------------------------------------
# progress_percent
# ---------------------------------------------------------------------------

class TestProgressPercent(unittest.TestCase):
    def test_50_percent(self):
        pct = clip.progress_percent("5000000", 10.0)
        self.assertAlmostEqual(pct, 50.0)

    def test_clamps_to_100(self):
        pct = clip.progress_percent("20000000", 10.0)
        self.assertAlmostEqual(pct, 100.0)

    def test_zero_elapsed(self):
        pct = clip.progress_percent("0", 10.0)
        self.assertAlmostEqual(pct, 0.0)

    def test_none_duration_returns_none(self):
        self.assertIsNone(clip.progress_percent("5000000", None))

    def test_zero_duration_returns_none(self):
        self.assertIsNone(clip.progress_percent("5000000", 0))

    def test_invalid_value_string_returns_none(self):
        self.assertIsNone(clip.progress_percent("N/A", 10.0))

    def test_100_percent_exact(self):
        pct = clip.progress_percent("10000000", 10.0)
        self.assertAlmostEqual(pct, 100.0)


# ---------------------------------------------------------------------------
# delete_partial_output
# ---------------------------------------------------------------------------

class TestDeletePartialOutput(unittest.TestCase):
    def test_deletes_existing_file(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            path = f.name
        self.assertTrue(Path(path).exists())
        clip.delete_partial_output(path)
        self.assertFalse(Path(path).exists())

    def test_nonexistent_file_does_not_raise(self):
        clip.delete_partial_output("/tmp/definitely_does_not_exist_clip_99999.mp4")

    def test_empty_string_does_not_raise(self):
        clip.delete_partial_output("")


# ---------------------------------------------------------------------------
# Command list sanity: no shell=True risk
# ---------------------------------------------------------------------------

class TestCmdListsSanity(unittest.TestCase):
    def _all_strings(self, cmd):
        for arg in cmd:
            self.assertIsInstance(arg, str, f"Expected str, got {type(arg)}: {arg!r}")

    def test_copy_cmd_all_strings(self):
        cmd = clip.build_copy_cmd("/in.mp4", "/out.mp4", 0.0, 10.0)
        self._all_strings(cmd)

    def test_reencode_cmd_all_strings(self):
        cmd = clip.build_reencode_cmd("/in.mp4", "/out.mp4", 0.0, 10.0)
        self._all_strings(cmd)


# ---------------------------------------------------------------------------
# Export preset constants
# ---------------------------------------------------------------------------

class TestExportPresetConstants(unittest.TestCase):
    def test_export_presets_keys(self):
        for entry in clip.EXPORT_PRESETS:
            for key in ("label", "scale_filter", "crf", "audio_bitrate"):
                self.assertIn(key, entry, f"Missing key {key!r} in {entry}")

    def test_resolution_options_keys(self):
        for entry in clip.RESOLUTION_OPTIONS:
            for key in ("label", "scale_filter"):
                self.assertIn(key, entry, f"Missing key {key!r} in {entry}")

    def test_crf_options_keys(self):
        for entry in clip.CRF_OPTIONS:
            for key in ("label", "crf"):
                self.assertIn(key, entry, f"Missing key {key!r} in {entry}")

    def test_crf_values_in_valid_range(self):
        for entry in clip.CRF_OPTIONS:
            self.assertIsInstance(entry["crf"], int)
            self.assertGreaterEqual(entry["crf"], 1)
            self.assertLessEqual(entry["crf"], 51)

    def test_export_presets_crf_in_valid_range(self):
        for entry in clip.EXPORT_PRESETS:
            self.assertIsInstance(entry["crf"], int)
            self.assertGreaterEqual(entry["crf"], 1)
            self.assertLessEqual(entry["crf"], 51)

    def test_audio_bitrate_format(self):
        import re
        pattern = re.compile(r'^\d+k$')
        for entry in clip.EXPORT_PRESETS:
            self.assertRegex(entry["audio_bitrate"], pattern)

    def test_first_export_preset_is_original(self):
        first = clip.EXPORT_PRESETS[0]
        self.assertIsNone(first["scale_filter"])
        self.assertEqual(first["crf"], 18)

    def test_first_resolution_option_is_original(self):
        self.assertIsNone(clip.RESOLUTION_OPTIONS[0]["scale_filter"])

    def test_first_crf_option_is_high(self):
        self.assertEqual(clip.CRF_OPTIONS[0]["crf"], 18)


# ---------------------------------------------------------------------------
# build_reencode_cmd — parameterized invocations
# ---------------------------------------------------------------------------

class TestBuildReencodeCmdParams(unittest.TestCase):
    _IN = "/in/file.mp4"
    _OUT = "/out/clip.mp4"

    def _build(self, **kwargs):
        return clip.build_reencode_cmd(self._IN, self._OUT, 0.0, 10.0, **kwargs)

    def test_scale_filter_inserted(self):
        cmd = self._build(scale_filter="scale=-2:480")
        self.assertIn("-vf", cmd)
        self.assertIn("scale=-2:480", cmd)
        vf_idx = cmd.index("-vf")
        cv_idx = cmd.index("-c:v")
        self.assertLess(vf_idx, cv_idx)

    def test_no_scale_filter_omits_vf(self):
        cmd = self._build(scale_filter=None)
        self.assertNotIn("-vf", cmd)

    def test_custom_crf(self):
        cmd = self._build(crf=28)
        crf_idx = cmd.index("-crf")
        self.assertEqual(cmd[crf_idx + 1], "28")

    def test_custom_audio_bitrate(self):
        cmd = self._build(audio_bitrate="64k")
        ba_idx = cmd.index("-b:a")
        self.assertEqual(cmd[ba_idx + 1], "64k")

    def test_output_still_last(self):
        cmd = self._build(scale_filter="scale=-2:480", crf=28, audio_bitrate="64k")
        self.assertEqual(cmd[-1], self._OUT)

    def test_all_strings_with_params(self):
        cmd = self._build(scale_filter="scale=-2:480", crf=28, audio_bitrate="64k")
        for arg in cmd:
            self.assertIsInstance(arg, str, f"Expected str, got {type(arg)}: {arg!r}")

    def test_setsar_filter(self):
        cmd = self._build(scale_filter="scale=720:480,setsar=1")
        self.assertIn("scale=720:480,setsar=1", cmd)


# ---------------------------------------------------------------------------
# BatchItem
# ---------------------------------------------------------------------------

class TestBatchItem(unittest.TestCase):
    def _make(self, **overrides):
        defaults = dict(
            input_path="/src/video.mp4",
            output_path="/out/clip.mp4",
            start_ms=0,
            end_ms=5000,
            reencode=False,
            scale_filter=None,
            crf=18,
            audio_bitrate="128k",
        )
        defaults.update(overrides)
        return clip.BatchItem(**defaults)

    def test_default_status_is_pending(self):
        item = self._make()
        self.assertEqual(item.status, "Pending")

    def test_default_progress_is_zero(self):
        item = self._make()
        self.assertEqual(item.progress, 0.0)

    def test_fields_stored(self):
        item = self._make(
            input_path="/a/b.mp4",
            output_path="/c/d.mp4",
            start_ms=1000,
            end_ms=9000,
            reencode=True,
            scale_filter="scale=-2:480",
            crf=23,
            audio_bitrate="96k",
        )
        self.assertEqual(item.input_path, "/a/b.mp4")
        self.assertEqual(item.output_path, "/c/d.mp4")
        self.assertEqual(item.start_ms, 1000)
        self.assertEqual(item.end_ms, 9000)
        self.assertTrue(item.reencode)
        self.assertEqual(item.scale_filter, "scale=-2:480")
        self.assertEqual(item.crf, 23)
        self.assertEqual(item.audio_bitrate, "96k")


# ---------------------------------------------------------------------------
# make_batch_item
# ---------------------------------------------------------------------------

class TestMakeBatchItem(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp()
        self._real_input = os.path.join(self._tmpdir, "source.mp4")
        Path(self._real_input).touch()
        self._real_output = os.path.join(self._tmpdir, "output.mp4")

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _call(self, **overrides):
        defaults = dict(
            input_path=self._real_input,
            output_path=self._real_output,
            start_ms=0,
            end_ms=5000,
            reencode=False,
            scale_filter=None,
            crf=18,
            audio_bitrate="128k",
        )
        defaults.update(overrides)
        return clip.make_batch_item(**defaults)

    def test_valid_returns_item_and_none(self):
        item, err = self._call()
        self.assertIsInstance(item, clip.BatchItem)
        self.assertIsNone(err)

    def test_invalid_input_returns_none_and_error(self):
        item, err = self._call(input_path="")
        self.assertIsNone(item)
        self.assertIsInstance(err, str)
        self.assertTrue(len(err) > 0)

    def test_bad_range_returns_error(self):
        item, err = self._call(start_ms=5000, end_ms=5000)
        self.assertIsNone(item)
        self.assertIsInstance(err, str)

    def test_item_has_pending_status(self):
        item, _ = self._call()
        self.assertEqual(item.status, "Pending")

    def test_item_progress_zero(self):
        item, _ = self._call()
        self.assertEqual(item.progress, 0.0)


# ---------------------------------------------------------------------------
# batch_item_row_text
# ---------------------------------------------------------------------------

class TestBatchItemRowText(unittest.TestCase):
    def _make_item(self, **overrides):
        defaults = dict(
            input_path="/some/dir/source.mp4",
            output_path="/other/dir/output.mp4",
            start_ms=0,
            end_ms=5000,
            reencode=False,
            scale_filter=None,
            crf=18,
            audio_bitrate="128k",
        )
        defaults.update(overrides)
        return clip.BatchItem(**defaults)

    def test_source_is_filename_only(self):
        item = self._make_item(input_path="/some/deep/path/myvideo.mp4")
        src, _, _, _ = clip.batch_item_row_text(item)
        self.assertNotIn("/", src)
        self.assertIn("myvideo.mp4", src)

    def test_range_contains_times(self):
        item = self._make_item(start_ms=1000, end_ms=5000)
        _, rng, _, _ = clip.batch_item_row_text(item)
        self.assertIn(clip.format_time(1000), rng)
        self.assertIn(clip.format_time(5000), rng)

    def test_output_is_filename_only(self):
        item = self._make_item(output_path="/some/deep/path/myoutput.mp4")
        _, _, out, _ = clip.batch_item_row_text(item)
        self.assertNotIn("/", out)
        self.assertIn("myoutput.mp4", out)

    def test_status_field(self):
        item = self._make_item()
        item.status = "Running"
        _, _, _, status = clip.batch_item_row_text(item)
        self.assertEqual(status, "Running")

    def test_long_name_not_truncated(self):
        long_name = "a" * 40 + ".mp4"
        item = self._make_item(input_path=f"/some/dir/{long_name}")
        src, _, _, _ = clip.batch_item_row_text(item)
        self.assertEqual(src, long_name)


# ---------------------------------------------------------------------------
# batch_progress_label
# ---------------------------------------------------------------------------

class TestBatchProgressLabel(unittest.TestCase):
    def test_zero_of_zero(self):
        self.assertEqual(clip.batch_progress_label(0, 0), "0 of 0 done")

    def test_partial(self):
        self.assertEqual(clip.batch_progress_label(3, 7), "3 of 7 done")

    def test_all_done(self):
        self.assertEqual(clip.batch_progress_label(7, 7), "7 of 7 done")


if __name__ == "__main__":
    unittest.main()
