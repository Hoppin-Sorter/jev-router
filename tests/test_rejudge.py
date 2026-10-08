"""Tests for eval/rejudge.py with a stand-in `claude` CLI: python3 -m unittest discover -s tests"""
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "eval"))
import rejudge  # noqa: E402
import run_eval  # noqa: E402
from test_eval import FAKE_CLAUDE  # noqa: E402


class RejudgeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        d = self.dir.name
        self.claude = os.path.join(d, "claude")
        with open(self.claude, "w") as f:
            f.write(FAKE_CLAUDE)
        os.chmod(self.claude, os.stat(self.claude).st_mode | stat.S_IEXEC)
        prompts = os.path.join(d, "prompts.jsonl")
        with open(prompts, "w") as f:
            f.write(json.dumps({"subject": "science", "tier": "deep", "prompt": "Derive the enzyme rate law."}) + "\n")
            f.write(json.dumps({"subject": "writing", "tier": "routine", "prompt": "Write a short email."}) + "\n")
        self.out = os.path.join(d, "results")
        with redirect_stdout(io.StringIO()):
            run_eval.main(["--prompts", prompts, "--claude-bin", self.claude, "--out", self.out, "--yes"])
        self.answers = os.path.join(self.out, "answers.jsonl")

    def tearDown(self):
        self.dir.cleanup()

    def test_grades_every_saved_answer_with_the_chosen_judge_and_can_resume(self):
        args = ["--answers", self.answers, "--judge", "sonnet", "--claude-bin", self.claude, "--yes", "--jobs", "2"]
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(rejudge.main(args), 0)
        graded = [json.loads(line) for line in open(os.path.join(self.out, "rejudge-sonnet.jsonl"))]
        self.assertEqual(len(graded), 2)
        for g in graded:
            self.assertEqual(g["judge"], "sonnet")
            self.assertEqual(sorted(g["scores"]), ["fable", "haiku", "opus", "sonnet"])
        self.assertIn("| fable |", buf.getvalue())
        buf = io.StringIO()
        with redirect_stdout(buf):
            rejudge.main(args + ["--resume"])
        self.assertIn("resuming: 2 prompts already graded", buf.getvalue())
        self.assertEqual(len(open(os.path.join(self.out, "rejudge-sonnet.jsonl")).read().splitlines()), 2)

    def test_dry_run_makes_no_calls(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = rejudge.main(["--answers", self.answers, "--judge", "fable", "--claude-bin", "/nonexistent/claude", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("2 prompts, one fable judge call each", buf.getvalue())
        self.assertFalse(os.path.exists(os.path.join(self.out, "rejudge-fable.jsonl")))


if __name__ == "__main__":
    unittest.main()
