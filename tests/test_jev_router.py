"""Tests for the standalone Python router (lib/jev_router.py): python3 -m unittest discover tests"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import jev_router  # noqa: E402
from jev_router import Router, pick_tier  # noqa: E402


def answers(tier=None, risky=None, skill=None, subject=None, output=None):
    top = lambda p: max(p, key=p.get)  # noqa: E731
    a = {}
    if tier:
        a["tier"] = {"choice": top(tier), "probabilities": tier}
    if risky is not None:
        a["risky"] = {"noul": risky}
    if skill:
        a["skill"] = {"choice": top(skill), "probabilities": skill}
    if subject:
        a["subject"] = {"choice": top(subject), "probabilities": subject}
    if output:
        a["output"] = {"choice": top(output), "probabilities": output}
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
        r = jev_router.Route(tier="routine", model="gpt-6.1-sol", effort="medium", subject=None, output=None, specialist=False, skill=None, routed=True, why="")
        self.assertEqual(
            jev_router.codex_argv(r, "fix it", interactive=False),
            ["codex", "exec", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="medium"', "fix it"],
        )
        r = jev_router.Route(tier="mechanical", model="gpt-6-luna", effort=None, subject=None, output=None, specialist=False, skill="sql", routed=True, why="")
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



DEEP_SCIENCE = dict(tier={"complex": 0.05, "deep": 0.95}, risky=0.0, subject={"science": 0.97, "math": 0.03}, output={"explanation": 0.9, "analysis": 0.1})


class SubjectAndFocusTest(unittest.TestCase):
    def router(self, reply, **kw):
        r = Router("k", **kw)
        r._post = lambda body: answers(**reply())
        return r

    def test_specialist_and_focus(self):
        balanced = self.router(lambda: DEEP_SCIENCE).route("x")
        self.assertEqual((balanced.model, balanced.specialist, balanced.subject), ("claude-fable-5-1", True, "science"))
        lean = self.router(lambda: DEEP_SCIENCE, focus="token-efficient").route("x")
        self.assertEqual((lean.model, lean.effort), ("claude-opus-5-5", "high"))

    def test_follow_up_holds_specialist_until_focus_changes(self):
        state = {"reply": DEEP_SCIENCE}
        r = self.router(lambda: state["reply"])
        self.assertEqual(r.route("derive it").model, "claude-fable-5-1")
        state["reply"] = dict(tier={"deep": 1.0}, risky=0.0, subject={"general": 0.9, "science": 0.1})
        follow = r.route("yes, go ahead")
        self.assertEqual(follow.model, "claude-fable-5-1")
        self.assertIn("held on claude-fable-5-1", follow.why)
        r.set_focus(0)
        self.assertEqual(r.route("next").model, "claude-opus-5-5")

    def test_task_focus_floor_and_quick_answer_effort(self):
        simple = dict(tier={"mechanical": 0.99, "routine": 0.01}, risky=0.0, output={"quick_answer": 0.9, "explanation": 0.1})
        r = self.router(lambda: simple, focus=4).route("x")
        self.assertEqual((r.model, r.effort), ("claude-sonnet-5-5", "medium"))

    def test_parse_focus(self):
        self.assertEqual([jev_router.parse_focus(v) for v in (0, "4", "lean", "Task-Focused")], [0, 4, 1, 4])
        with self.assertRaises(ValueError):
            jev_router.parse_focus("max")


class ParityTest(unittest.TestCase):
    """The TypeScript and Python routers must route identically: compare their tables."""

    def test_tables_match(self):
        import shutil
        import subprocess

        if not shutil.which("node"):
            self.skipTest("node not installed")
        lib = os.path.join(os.path.dirname(__file__), "..", "lib", "jev-router.ts")
        script = (
            f"import * as j from {json.dumps(os.path.abspath(lib))};"
            "console.log(JSON.stringify({rubric: j.TIER_RUBRIC, subjects: j.SUBJECT_RUBRIC, outputs: j.OUTPUT_RUBRIC,"
            " enough: j.ENOUGH, effort: j.TIER_EFFORT, models: j.DEFAULT_MODELS, oaModels: j.OPENAI_MODELS, oaEffort: j.OPENAI_EFFORT,"
            " specialists: j.CLAUDE_SPECIALISTS, focus: j.FOCUS, risk: j.RISK_FLOOR, skill: j.SKILL_MIN, label: j.LABEL_MIN}))"
        )
        out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True).stdout
        ts = json.loads(out)
        py_focus = {
            str(k): {"enough": v["enough"], "effortShift": v["effort_shift"], "specialists": v["specialists"], **({"minTier": v["min_tier"]} if v["min_tier"] else {})}
            for k, v in jev_router.FOCUS.items()
        }
        self.assertEqual(ts["rubric"], jev_router.TIER_RUBRIC)
        self.assertEqual(ts["subjects"], jev_router.SUBJECT_RUBRIC)
        self.assertEqual(ts["outputs"], jev_router.OUTPUT_RUBRIC)
        self.assertEqual(ts["enough"], jev_router.ENOUGH)
        self.assertEqual(ts["effort"], jev_router.TIER_EFFORT)
        self.assertEqual(ts["models"], jev_router.DEFAULT_MODELS)
        self.assertEqual(ts["oaModels"], jev_router.OPENAI_MODELS)
        self.assertEqual(ts["oaEffort"], jev_router.OPENAI_EFFORT)
        self.assertEqual(ts["specialists"], jev_router.CLAUDE_SPECIALISTS)
        self.assertEqual(ts["focus"], py_focus)
        self.assertEqual((ts["risk"], ts["skill"], ts["label"]), (jev_router.RISK_FLOOR, jev_router.SKILL_MIN, jev_router.LABEL_MIN))


if __name__ == "__main__":
    unittest.main()
