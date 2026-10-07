"""Checks widget/Fixtures/expected.json against a second, independent reading of the fixtures.

The menu bar widget's Swift checks (widget/Sources/JevCoreChecks) compare JevCore against the
same expected.json, so the numbers there are verified even where Swift isn't available.
"""
import datetime
import glob
import json
import os
import unittest

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "..", "widget", "Fixtures")

# USD per million tokens: input, output, cache read (Anthropic list prices, October 2026).
PRICES = {
    "haiku-4-5": (1, 5, 0.10),
    "sonnet-5-5": (2, 10, 0.20),
    "opus-5-5": (4, 20, 0.20),
    "fable-5-1": (10, 50, 0.25),
    "opus-5": (5, 25, 0.50),
    "fable-5": (10, 50, 1.00),
}
ORDER = list(PRICES)


def model_key(model_id):
    m = model_id.lower()
    for key in ORDER:
        i = m.find(key)
        if i < 0:
            continue
        rest = m[i + len(key):]
        if rest.startswith("-") and rest[1:2].isdigit():
            digits = len(rest[1:]) - len(rest[1:].lstrip("0123456789"))
            if digits < 8:
                continue
        return key
    return None


def cost(u, key):
    i, o, cr = PRICES[key]
    return (u["in"] * i + u["out"] * o + u["cr"] * cr + u["w5"] * i * 1.25 + u["w1"] * i * 2) / 1e6


def ts(s):
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def read_usage():
    seen = {}
    for path in glob.glob(os.path.join(FIXTURES, "projects", "**", "*.jsonl"), recursive=True):
        for line in open(path):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            msg = obj.get("message") or {}
            if obj.get("type") != "assistant" or "usage" not in msg:
                continue
            u = msg["usage"]
            written = u.get("cache_creation_input_tokens", 0)
            split = u.get("cache_creation")
            w1 = split.get("ephemeral_1h_input_tokens", 0) if split else 0
            seen[msg["id"] + "|" + obj.get("requestId", "")] = (
                msg["model"],
                ts(obj["timestamp"]),
                {"in": u.get("input_tokens", 0), "out": u.get("output_tokens", 0), "cr": u.get("cache_read_input_tokens", 0), "w5": written - w1, "w1": w1},
            )
    return list(seen.values())


class WidgetFixtureTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(FIXTURES, "expected.json")) as f:
            self.expected = json.load(f)

    def test_model_matching(self):
        for model_id, key in self.expected["models"].items():
            self.assertEqual(model_key(model_id), key, model_id)

    def test_windows(self):
        usage = read_usage()
        self.assertEqual(len(usage), self.expected["distinctRequests"])
        decisions = []
        for line in open(os.path.join(FIXTURES, "config", "decisions.jsonl")):
            try:
                decisions.append(json.loads(line))
            except ValueError:
                pass
        now = ts(self.expected["now"])
        starts = {"Today": ts(self.expected["now"][:10] + "T00:00:00Z"), "7 days": now - 7 * 86400, "30 days": now - 30 * 86400}
        for name, want in self.expected["windows"].items():
            start = starts[name]
            actual = baseline = 0.0
            requests = unpriced = 0
            mix = {}
            for model, at, u in usage:
                if not start <= at <= now:
                    continue
                key = model_key(model)
                if key is None:
                    unpriced += 1
                    continue
                requests += 1
                actual += cost(u, key)
                baseline += cost(u, "opus-5-5")
                mix[key] = mix.get(key, 0) + 1
            jev = sum(d.get("jevCostUsd", 0) for d in decisions if start <= d["at"] / 1000 <= now)
            self.assertAlmostEqual(actual, want["actual"], places=9, msg=name)
            self.assertAlmostEqual(baseline, want["baseline"], places=9, msg=name)
            self.assertAlmostEqual(jev, want["jev"], places=12, msg=name)
            self.assertEqual((requests, unpriced), (want["requests"], want["unpriced"]), name)
            ordered = sorted(mix.items(), key=lambda kv: (-kv[1], ORDER.index(kv[0])))
            self.assertEqual([list(kv) for kv in ordered], want["mix"], name)

    def test_impact(self):
        f = self.expected["impactFactors"]
        for name, want in self.expected["impact"].items():
            w = self.expected["windows"][name]
            saved = w["baseline"] - w["actual"] - w["jev"]
            self.assertAlmostEqual(saved, want["saved"], places=12, msg=name)
            wh = saved * f["whPerUSD"]
            self.assertAlmostEqual(wh, want["energyWh"], places=9, msg=name)
            self.assertAlmostEqual(wh / 1000 * f["litersPerKWh"], want["waterL"], places=12, msg=name)
            self.assertAlmostEqual(wh / 1000 * f["kgCO2PerKWh"], want["co2Kg"], places=12, msg=name)


if __name__ == "__main__":
    unittest.main()
