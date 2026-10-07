"""Tests for the standalone Python router (lib/jev_router.py): python3 -m unittest discover tests"""
import os
import sys
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


if __name__ == "__main__":
    unittest.main()
