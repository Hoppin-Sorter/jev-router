"""Tests for eval/run_eval.py with a stand-in `claude` CLI: python3 -m unittest discover -s tests"""
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "eval"))
import run_eval  # noqa: E402

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, re, sys
argv = sys.argv[1:]
# Nothing from the user's setup may steer the run: no settings, MCP servers, skills or tools.
assert "--bare" not in argv and argv[argv.index("--setting-sources") + 1] == "", argv
assert "--strict-mcp-config" in argv and "--disable-slash-commands" in argv and argv[argv.index("--tools") + 1] == "", argv
model = argv[argv.index("--model") + 1]
prompt = argv[-1]
if prompt.startswith("You are grading"):
    hard = "enzyme" in prompt
    table = {"claude-fable-5-1": 9.5 if hard else 9, "claude-opus-5-5": 8.0 if hard else 8.7,
             "claude-sonnet-5-5": 7 if hard else 8.6, "claude-haiku-4-5": 5 if hard else 6}
    scores = {}
    for label, body in re.findall(r'<answer id="(\w)">\n(.*?)\n</answer>', prompt, re.S):
        scores[label] = {"score": table[body.split("answer by ")[1].strip()], "why": "x"}
    print(json.dumps({"result": "Here you go: " + json.dumps(scores), "total_cost_usd": 0.01}))
else:
    print(json.dumps({"result": "answer by " + model, "total_cost_usd": {"claude-fable-5-1": 0.05, "claude-opus-5-5": 0.02, "claude-sonnet-5-5": 0.01, "claude-haiku-4-5": 0.005}[model]}))
'''


class EvalTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        d = self.dir.name
        self.claude = os.path.join(d, "claude")
        with open(self.claude, "w") as f:
            f.write(FAKE_CLAUDE)
        os.chmod(self.claude, os.stat(self.claude).st_mode | stat.S_IEXEC)
        self.prompts = os.path.join(d, "prompts.jsonl")
        with open(self.prompts, "w") as f:
            f.write(json.dumps({"subject": "science", "tier": "deep", "prompt": "Derive the enzyme rate law."}) + "\n")
            f.write(json.dumps({"subject": "writing", "tier": "routine", "prompt": "Write a short email."}) + "\n")

    def tearDown(self):
        self.dir.cleanup()

    def test_full_run_suggests_fable_only_where_it_clearly_wins(self):
        out = os.path.join(self.dir.name, "results")
        with redirect_stdout(io.StringIO()):
            code = run_eval.main(["--prompts", self.prompts, "--claude-bin", self.claude, "--out", out, "--yes"])
        self.assertEqual(code, 0)
        table = json.load(open(os.path.join(out, "suggested-specialists.json")))
        # science/deep: Fable 9.5 vs Opus 8.0 -> Fable. writing/routine: Sonnet is within 0.5 of the best -> default, no entry.
        self.assertEqual(table, {"science": {"deep": {"model": "claude-fable-5-1", "premium": True}}})
        summary = open(os.path.join(out, "summary.md")).read()
        self.assertIn("| science | deep |", summary)
        self.assertEqual(len(open(os.path.join(out, "answers.jsonl")).read().splitlines()), 8)

    def test_parallel_run_can_resume_and_redoes_a_prompt_missing_a_model(self):
        out = os.path.join(self.dir.name, "results")
        base = ["--prompts", self.prompts, "--claude-bin", self.claude, "--out", out, "--yes", "--jobs", "2"]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(run_eval.main(base), 0)
        log = os.path.join(out, "answers.jsonl")
        rows = [json.loads(line) for line in open(log)]
        self.assertEqual(len(rows), 8)
        # One model's answer to one prompt is lost: only that prompt runs again.
        kept = [r for r in rows if not (r["subject"] == "science" and r["model"] == "fable")]
        with open(log, "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in kept)
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(run_eval.main(base + ["--resume"]), 0)
        self.assertIn("1 prompts already answered by every model", buf.getvalue())
        again = [json.loads(line) for line in open(log)]
        self.assertEqual(len(again), 8)
        self.assertEqual(len({(r["prompt"], r["model"]) for r in again}), 8)

    def test_dry_run_makes_no_calls(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = run_eval.main(["--prompts", self.prompts, "--claude-bin", "/nonexistent/claude", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("2 prompts x 4 models + 1 judge call each = 10 calls", buf.getvalue())

    def test_parse_scores_ignores_noise_and_out_of_range(self):
        self.assertEqual(run_eval.parse_scores('ok {"A": {"score": 8}, "B": {"score": 11}, "C": 6}', ["A", "B", "C"]), {"A": 8.0, "C": 6.0})
        self.assertEqual(run_eval.parse_scores("no json here", ["A"]), {})


if __name__ == "__main__":
    unittest.main()
