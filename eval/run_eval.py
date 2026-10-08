#!/usr/bin/env python3
"""Tune jev-router's model table with your own prompts.

Every prompt in prompts.jsonl is answered by each model (through `claude -p`, so it
runs on your Claude plan or API key, whichever your CLI uses), then a judge model
grades the answers blind. The summary shows, for each subject and difficulty, the
cheapest model whose average score is within --tolerance of the best, and writes the
specialists table to paste into lib/jev-router.ts and lib/jev_router.py.

    python3 eval/run_eval.py --dry-run            # plan and rough cost, no calls
    python3 eval/run_eval.py --limit 4            # a small first run
    python3 eval/run_eval.py --subjects science,math
    python3 eval/run_eval.py --jobs 6 --resume    # 6 prompts at once; skip prompts already answered

Runs load no settings, plugins, hooks, MCP servers or skills (so nothing, including
jev-router, steers them), use no tools, and start in an empty folder, so every model
answers the same plain question. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

# Claude API model IDs and $ per million input/output tokens (Anthropic's pricing page, October 2026).
MODELS = {
    "haiku": ("claude-haiku-4-5", 1.0, 5.0),
    "sonnet": ("claude-sonnet-5-5", 2.0, 10.0),
    "opus": ("claude-opus-5-5", 4.0, 20.0),
    "fable": ("claude-fable-5-1", 10.0, 50.0),
}
# The router's model for each tier, to tell which recommendations differ from it.
TIER_DEFAULT = {"mechanical": "haiku", "routine": "sonnet", "complex": "opus", "deep": "opus"}
# Rough tokens per call for --dry-run estimates only (answers include thinking).
EST_ANSWER = (1_500, 2_500)
EST_JUDGE_EXTRA_IN, EST_JUDGE_OUT = 1_000, 600

JUDGE_PROMPT = """You are grading answers to the same question from different assistants. The assistants are anonymous and in random order.

Score each answer from 1 to 10. Correctness matters most: a confident wrong answer scores low even if well written. Then completeness for what was asked, then clarity. Don't reward length for its own sake.

Question:
<question>
{question}
</question>

{answers}

Reply with only a JSON object, no other text, like: {{"A": {{"score": 7, "why": "one short sentence"}}, "B": {{"score": 9, "why": "..."}}}}"""


# An empty folder to run in, so no project's CLAUDE.md or memory is picked up.
ISOLATED_CWD = tempfile.mkdtemp(prefix="jev-eval-")
# What --bare would skip, without --bare: it only takes an API key, and this way a Claude
# subscription sign-in works too. With no settings loaded, no plugin is enabled, jev-router
# included; left on, it would switch the model these runs ask for.
ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--tools", ""]
# With no tools, a model asked to edit code sometimes tries to call one anyway and the run fails.
NO_TOOLS = "You have no tools and no access to files. Answer in your reply alone, with any code written out in full in the reply."


def call_claude(binary: str, model: str, prompt: str, timeout: int = 900) -> dict:
    """One headless Claude run: no plugins, hooks, MCP servers, skills or tools, and no saved session. Returns text and cost."""
    argv = [binary, "-p", *ISOLATION, "--append-system-prompt", NO_TOOLS, "--model", model, "--output-format", "json", prompt]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=ISOLATED_CWD)
    except (OSError, subprocess.TimeoutExpired) as err:
        return {"text": "", "cost": None, "error": str(err)}
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"text": "", "cost": None, "error": (proc.stderr or proc.stdout).strip()[:300] or f"exit {proc.returncode}"}
    if out.get("is_error"):
        return {"text": "", "cost": out.get("total_cost_usd"), "error": str(out.get("result"))[:300]}
    return {"text": out.get("result") or "", "cost": out.get("total_cost_usd"), "error": None}


def parse_scores(text: str, labels: List[str]) -> Dict[str, float]:
    """Pulls {"A": {"score": n}} out of the judge's reply; tolerates text around the JSON."""
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return {}
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {}
    scores = {}
    for label in labels:
        item = data.get(label)
        score = item.get("score") if isinstance(item, dict) else item
        if isinstance(score, (int, float)) and 1 <= score <= 10:
            scores[label] = float(score)
    return scores


def judge(binary: str, judge_model: str, question: str, answers: Dict[str, str], rng: random.Random) -> Dict[str, float]:
    """Grades every model's answer to one question in a single blind call. Returns score per model."""
    names = list(answers)
    rng.shuffle(names)
    labels = [chr(ord("A") + i) for i in range(len(names))]
    block = "\n\n".join(f"<answer id=\"{lab}\">\n{answers[name]}\n</answer>" for lab, name in zip(labels, names))
    reply = call_claude(binary, judge_model, JUDGE_PROMPT.format(question=question, answers=block))
    scores = parse_scores(reply["text"], labels)
    return {name: scores[lab] for lab, name in zip(labels, names) if lab in scores}


def recommend(rows: List[dict], tolerance: float) -> Dict[str, Dict[str, dict]]:
    """For each subject and tier: mean score and cost per model, and the cheapest model within
    `tolerance` of the best mean score."""
    grouped: Dict[tuple, Dict[str, List[dict]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        if row.get("score") is not None:
            grouped[(row["subject"], row["tier"])][row["model"]].append(row)
    result: Dict[str, Dict[str, dict]] = defaultdict(dict)
    for (subject, tier), by_model in grouped.items():
        stats = {
            m: {
                "score": round(sum(r["score"] for r in rs) / len(rs), 2),
                "cost": round(sum(r["cost"] or 0 for r in rs) / len(rs), 4),
                "n": len(rs),
            }
            for m, rs in by_model.items()
        }
        best = max(s["score"] for s in stats.values())
        by_price = sorted(stats, key=lambda m: (MODELS[m][1], MODELS[m][2]))
        pick = next(m for m in by_price if stats[m]["score"] >= best - tolerance)
        result[subject][tier] = {"models": stats, "pick": pick, "best": best}
    return result


def specialists_table(rec: Dict[str, Dict[str, dict]]) -> dict:
    """The router's specialists shape: only cells where the pick differs from the tier's default model."""
    table: Dict[str, dict] = {}
    for subject, tiers in rec.items():
        for tier, info in tiers.items():
            pick, default = info["pick"], TIER_DEFAULT.get(tier)
            if pick != default:
                premium = MODELS[pick][1] > MODELS[default][1]
                table.setdefault(subject, {})[tier] = {"model": MODELS[pick][0], **({"premium": True} if premium else {})}
    return table


def summary_markdown(rec: Dict[str, Dict[str, dict]], models: List[str], judge_name: str, tolerance: float) -> str:
    lines = [
        "# jev-router eval summary",
        "",
        f"Judge: {judge_name}. Pick = cheapest model within {tolerance} points of the best average score.",
        f"Note: a judge can favor answers like its own; rerun with another --judge to check.",
        "",
        "| Subject | Tier | " + " | ".join(f"{m} (score / $)" for m in models) + " | Pick |",
        "|---|---|" + "---|" * len(models) + "---|",
    ]
    for subject in sorted(rec):
        for tier in sorted(rec[subject]):
            info = rec[subject][tier]
            cells = []
            for m in models:
                s = info["models"].get(m)
                cells.append(f"{s['score']} / {s['cost']}" if s else "—")
            lines.append(f"| {subject} | {tier} | " + " | ".join(cells) + f" | **{info['pick']}** |")
    return "\n".join(lines) + "\n"


def estimate(n_prompts: int, models: List[str], judge_name: str) -> float:
    answer_cost = sum((EST_ANSWER[0] * MODELS[m][1] + EST_ANSWER[1] * MODELS[m][2]) / 1e6 for m in models) * n_prompts
    judge_in = EST_JUDGE_EXTRA_IN + EST_ANSWER[1] * len(models)
    judge_cost = n_prompts * (judge_in * MODELS[judge_name][1] + EST_JUDGE_OUT * MODELS[judge_name][2]) / 1e6
    return answer_cost + judge_cost


def main(argv: Optional[list] = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Grade each model on your prompts and suggest the router's specialists table.")
    ap.add_argument("--prompts", default=os.path.join(here, "prompts.jsonl"))
    ap.add_argument("--models", default="haiku,sonnet,opus,fable", help="comma-separated: " + ", ".join(MODELS))
    ap.add_argument("--judge", default="opus", choices=sorted(MODELS))
    ap.add_argument("--subjects", help="only these subjects (comma-separated)")
    ap.add_argument("--limit", type=int, help="only the first N prompts")
    ap.add_argument("--tolerance", type=float, default=0.5, help="how close to the best score counts as good enough")
    ap.add_argument("--claude-bin", default="claude", help="the claude CLI to run (default: claude on PATH)")
    ap.add_argument("--out", default=os.path.join(here, "results"))
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--dry-run", action="store_true", help="show the plan and a rough cost, make no calls")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    ap.add_argument("--jobs", type=int, default=1, help="prompts to work on at once (each runs its models one after another)")
    ap.add_argument("--resume", action="store_true", help="keep answers.jsonl in --out and skip the prompts it already has")
    args = ap.parse_args(argv)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    unknown = [m for m in models if m not in MODELS]
    if unknown:
        ap.error(f"unknown model(s): {', '.join(unknown)}")
    with open(args.prompts) as f:
        prompts = [json.loads(line) for line in f if line.strip()]
    if args.subjects:
        wanted = {s.strip() for s in args.subjects.split(",")}
        prompts = [p for p in prompts if p["subject"] in wanted]
    if args.limit:
        prompts = prompts[: args.limit]
    if not prompts:
        ap.error("no prompts selected")

    done_rows: List[dict] = []
    log_path = os.path.join(args.out, "answers.jsonl")
    if args.resume and os.path.exists(log_path):
        with open(log_path) as f:
            logged = [json.loads(line) for line in f if line.strip()]
        # A prompt counts as done only when every model answered it; the rest run again.
        by_prompt: Dict[str, set] = defaultdict(set)
        for r in logged:
            by_prompt[r["prompt"]].add(r["model"])
        answered = {p for p, ms in by_prompt.items() if set(models) <= ms}
        done_rows = [r for r in logged if r["prompt"] in answered]
        with open(log_path, "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in done_rows)
        print(f"resuming: {len(answered)} prompts already answered by every model")
        prompts = [p for p in prompts if p["prompt"] not in answered]

    calls = len(prompts) * (len(models) + 1)
    cost = estimate(len(prompts), models, args.judge)
    print(f"{len(prompts)} prompts x {len(models)} models + 1 judge call each = {calls} calls")
    print(f"rough cost at API prices: ${cost:.2f} (on a Claude plan this counts against your usage limits instead)")
    if args.dry_run:
        return 0
    if not args.yes:
        try:
            if input("Run it? [y/N] ").strip().lower() != "y":
                return 1
        except EOFError:
            return 1

    os.makedirs(args.out, exist_ok=True)
    rows: List[dict] = list(done_rows)
    lock = threading.Lock()
    finished = [0]

    def run_one(item: dict) -> None:
        answers, costs = {}, {}
        for m in models:
            r = call_claude(args.claude_bin, MODELS[m][0], item["prompt"])
            if r["error"]:
                r = call_claude(args.claude_bin, MODELS[m][0], item["prompt"])  # once more, for a passing hiccup
            if r["error"]:
                print(f"  {item['subject']}/{item['tier']} {m}: error: {r['error']}", file=sys.stderr)
                continue
            answers[m], costs[m] = r["text"], r["cost"]
        # Each prompt shuffles with its own seed, so the blind order doesn't depend on which thread ran first.
        rng = random.Random(f"{args.seed}:{item['prompt']}")
        scores = judge(args.claude_bin, MODELS[args.judge][0], item["prompt"], answers, rng) if answers else {}
        with lock:
            for m in answers:
                row = {**item, "model": m, "score": scores.get(m), "cost": costs[m], "answer": answers[m]}
                rows.append(row)
                log.write(json.dumps(row) + "\n")
            log.flush()
            finished[0] += 1
            got = ", ".join(f"{m} {scores[m]:g}" for m in models if m in scores) or "no scores"
            print(f"  [{finished[0]}/{len(prompts)}] {item['subject']}/{item['tier']}: {got}", flush=True)

    with open(log_path, "a" if args.resume else "w") as log:
        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            list(pool.map(run_one, prompts))

    rec = recommend(rows, args.tolerance)
    with open(os.path.join(args.out, "summary.md"), "w") as f:
        f.write(summary_markdown(rec, models, args.judge, args.tolerance))
    table = specialists_table(rec)
    with open(os.path.join(args.out, "suggested-specialists.json"), "w") as f:
        json.dump(table, f, indent=2)
    print(f"\nwrote {args.out}/summary.md and suggested-specialists.json")
    print(json.dumps(table, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
