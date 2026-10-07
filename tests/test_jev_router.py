"""Tests for the standalone Python router (lib/jev_router.py): python3 -m unittest discover tests"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import jev_router  # noqa: E402
from jev_router import Router, pick_tier  # noqa: E402


def answers(tier=None, risky=None, skill=None):
    top = lambda p: max(p, key=p.get)  # noqa: E731
    a = {}
    if tier:
        a["tier"] = {"choice": top(tier), "probabilities": tier}
    if risky is not None:
        a["risky"] = {"noul": risky}
    if skill:
        a["skill"] = {"choice": top(skill), "probabilities": skill}
    return {"answers": a}


class RouterTest(unittest.TestCase):
    def test_doubt_rounds_up(self):
        self.assertEqual(pick_tier({"mechanical": 0.9, "routine": 0.1}), "mechanical")
        self.assertEqual(pick_tier({"mechanical": 0.6, "routine": 0.3, "complex": 0.1}), "routine")
        self.assertEqual(pick_tier({"complex": 0.3, "deep": 0.7}), "deep")

    def test_routine_prompt(self):
        r = Router("k", skills=[{"name": "sql-queries", "description": "Write SQL"}])
        sent = []
        r._post = lambda body: (sent.append(body), answers({"routine": 0.9, "complex": 0.1}, 0.1, {"none": 0.2, "sql-queries": 0.8}))[1]
        route = r.route("weekly signups by country in BigQuery")
        self.assertEqual((route.model, route.effort, route.skill, route.routed), ("claude-sonnet-5-5", "medium", "sql-queries", True))
        self.assertEqual(list(sent[0]["questions"]["skill"]["criteria"]), ["none", "sql-queries"])

    def test_risky_hold_and_expiry(self):
        clock = [0.0]
        jev_router.time.monotonic = lambda: clock[0]
        r = Router("k")
        r._post = lambda body: answers({"mechanical": 0.95, "routine": 0.05}, 0.9)
        self.assertEqual(r.route("rotate the prod db password").model, "claude-opus-5-5")
        r._post = lambda body: answers({"mechanical": 0.95, "routine": 0.05}, 0.0)
        clock[0] += 60
        self.assertEqual(r.route("yes, go ahead").tier, "complex")
        clock[0] += 11 * 60
        fresh = r.route("rename foo to bar")
        self.assertEqual((fresh.model, fresh.effort), ("claude-haiku-4-5", None))

    def test_jev_down_uses_fallback(self):
        r = Router("k", fallback="routine")

        def down(body):
            raise OSError("connection refused")

        r._post = down
        route = r.route("anything")
        self.assertEqual((route.routed, route.model), (False, "claude-sonnet-5-5"))


class OpenAITest(unittest.TestCase):
    def route(self, tier, **kw):
        r = Router("k", provider="openai", **kw)
        r._post = lambda body: answers(tier, 0.0)
        return r.route("x")

    def test_presets(self):
        cases = [
            ({"mechanical": 0.95, "routine": 0.05}, "gpt-6-luna", "low"),
            ({"routine": 0.9, "complex": 0.1}, "gpt-6.1-sol", "medium"),
            ({"complex": 0.9, "deep": 0.1}, "gpt-6-astra", "high"),
            ({"deep": 1.0}, "gpt-6-astra", "xhigh"),
        ]
        for tier, model, effort in cases:
            r = self.route(tier)
            self.assertEqual((r.model, r.effort), (model, effort))

    def test_overrides(self):
        r = self.route({"complex": 0.9, "deep": 0.1}, models={"complex": "gpt-6.1-sol"}, efforts={"complex": None})
        self.assertEqual((r.model, r.effort), ("gpt-6.1-sol", None))


class CliTest(unittest.TestCase):
    def test_codex_argv(self):
        r = jev_router.Route("routine", "gpt-6.1-sol", "medium", None, True, "")
        self.assertEqual(
            jev_router.codex_argv(r, "fix it", interactive=False),
            ["codex", "exec", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="medium"', "fix it"],
        )
        r = jev_router.Route("mechanical", "gpt-6-luna", None, "sql", True, "")
        argv = jev_router.codex_argv(r, "q", interactive=True)
        self.assertEqual(argv[:3], ["codex", "-m", "gpt-6-luna"])
        self.assertNotIn("-c", argv)
        self.assertIn('"sql" skill', argv[-1])

    def test_load_skills(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "sql"))
            with open(os.path.join(d, "sql", "SKILL.md"), "w") as f:
                f.write("---\nname: sql-queries\ndescription: >\n  Write SQL\n  across dialects\n---\nbody")
            os.makedirs(os.path.join(d, "broken"))
            with open(os.path.join(d, "broken", "SKILL.md"), "w") as f:
                f.write("no front matter")
            self.assertEqual(jev_router.load_skills([d, "/does/not/exist"]), [{"name": "sql-queries", "description": "Write SQL across dialects"}])

    def test_api_key_order(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, ".config", "jev"))
            with open(os.path.join(home, ".config", "jev", "api_key"), "w") as f:
                f.write("from-file\n")
            self.assertEqual(jev_router.load_api_key({}, home), "from-file")
            self.assertEqual(jev_router.load_api_key({"JEV_API_KEY": "j"}, home), "j")
            self.assertEqual(jev_router.load_api_key({"JEV_API_KEY": "j", "TYPESAFE_API_KEY": "t"}, home), "t")
            self.assertIsNone(jev_router.load_api_key({}, os.path.join(home, "nowhere")))

    def test_run_launches_codex_with_the_routed_model(self):
        launched = []
        original = jev_router.Router._post
        jev_router.Router._post = lambda self, body: answers({"routine": 0.9, "complex": 0.1}, 0.0)
        old = dict(os.environ)
        os.environ["TYPESAFE_API_KEY"] = "k"
        try:
            code = jev_router.main(["--run", "codex-exec", "--skills-dir", "/nowhere", "fix", "the", "bug"], runner=launched.append)
        finally:
            jev_router.Router._post = original
            os.environ.clear()
            os.environ.update(old)
        self.assertEqual(code, 0)
        self.assertEqual(launched, [["codex", "exec", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="medium"', "fix the bug"]])


if __name__ == "__main__":
    unittest.main()
