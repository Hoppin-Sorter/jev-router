#!/usr/bin/env python3
"""Grade the answers from a run_eval.py run again, with a different judge.

run_eval.py has one judge grade every answer, and a judge can favor answers like its own.
This keeps the saved answers, has another judge grade them blind (a new shuffle for each
prompt), and writes its scores beside the first judge's so you can see whether the ranking
holds. It makes only judge calls, so it costs far less than the run that made the answers.

    python3 eval/rejudge.py --answers eval/results/answers.jsonl --judge sonnet --dry-run
    python3 eval/rejudge.py --answers eval/results/answers.jsonl --judge fable --jobs 6

Writes rejudge-<judge>.jsonl next to the answers, one line per prompt, and --resume skips
the prompts it already has. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

from run_eval import EST_JUDGE_EXTRA_IN, EST_JUDGE_OUT, MODELS, judge


def load_prompts(path: str) -> List[dict]:
    """The saved answers regrouped by prompt: {prompt, subject, tier, answers: {model: text}, scores: {model: score}}."""
    by_prompt: Dict[str, dict] = {}
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            item = by_prompt.setdefault(
                row["prompt"],
                {"id": row.get("id"), "prompt": row["prompt"], "subject": row["subject"], "tier": row["tier"], "answers": {}, "scores": {}},
            )
            item["answers"][row["model"]] = row["answer"]
            if row.get("score") is not None:
                item["scores"][row["model"]] = row["score"]
    return list(by_prompt.values())


def estimate(prompts: List[dict], judge_name: str) -> float:
    price_in, price_out = MODELS[judge_name][1], MODELS[judge_name][2]
    tokens_in = sum(EST_JUDGE_EXTRA_IN + sum(len(a) for a in p["answers"].values()) / 4 for p in prompts)
    return (tokens_in * price_in + len(prompts) * EST_JUDGE_OUT * price_out) / 1e6


def mean(values: List[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def main(argv: Optional[list] = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Grade a saved run's answers again with another judge.")
    ap.add_argument("--answers", default=os.path.join(here, "results", "answers.jsonl"))
    ap.add_argument("--judge", required=True, choices=sorted(MODELS))
    ap.add_argument("--claude-bin", default="claude", help="the claude CLI to run (default: claude on PATH)")
    ap.add_argument("--jobs", type=int, default=1, help="prompts to grade at once")
    ap.add_argument("--seed", type=int, default=11, help="shuffle seed; the first run used 7, so the order differs")
    ap.add_argument("--out", help="default: rejudge-<judge>.jsonl next to the answers")
    ap.add_argument("--resume", action="store_true", help="skip prompts already in the output file")
    ap.add_argument("--limit", type=int, help="only the first N prompts")
    ap.add_argument("--dry-run", action="store_true", help="show the plan and a rough cost, make no calls")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args(argv)

    prompts = load_prompts(args.answers)
    if args.limit:
        prompts = prompts[: args.limit]
    out_path = args.out or os.path.join(os.path.dirname(os.path.abspath(args.answers)), f"rejudge-{args.judge}.jsonl")
    done: List[dict] = []
    if args.resume and os.path.exists(out_path):
        with open(out_path) as f:
            done = [json.loads(line) for line in f if line.strip()]
        have = {d["prompt"] for d in done}
        prompts = [p for p in prompts if p["prompt"] not in have]
        print(f"resuming: {len(have)} prompts already graded")

    print(f"{len(prompts)} prompts, one {args.judge} judge call each; rough cost at API prices: ${estimate(prompts, args.judge):.2f}")
    if args.dry_run:
        return 0
    if not args.yes:
        try:
            if input("Run it? [y/N] ").strip().lower() != "y":
                return 1
        except EOFError:
            return 1

    lock = threading.Lock()
    finished = [0]
    graded: List[dict] = list(done)

    def run_one(item: dict) -> None:
        names = list(item["answers"])
        scores: Dict[str, float] = {}
        for attempt in range(2):  # once more, with a fresh shuffle, if the judge's reply didn't parse
            rng = random.Random(f"{args.seed}:{args.judge}:{attempt}:{item['prompt']}")
            scores = judge(args.claude_bin, MODELS[args.judge][0], item["prompt"], {m: item["answers"][m] for m in names}, rng)
            if len(scores) == len(names):
                break
        with lock:
            row = {"id": item["id"], "prompt": item["prompt"], "subject": item["subject"], "tier": item["tier"], "judge": args.judge, "scores": scores}
            graded.append(row)
            log.write(json.dumps(row) + "\n")
            log.flush()
            finished[0] += 1
            got = ", ".join(f"{m} {scores[m]:g}" for m in names if m in scores) or "no scores"
            print(f"  [{finished[0]}/{len(prompts)}] {item['subject']}/{item['tier']}: {got}", flush=True)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "a" if args.resume else "w") as log:
        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            list(pool.map(run_one, prompts))

    # Average score per model: the first judge's, then this one's.
    first = load_prompts(args.answers)
    models = [m for m in MODELS if any(m in p["answers"] for p in first)]
    mine: Dict[str, List[float]] = defaultdict(list)
    for g in graded:
        for m, s in g["scores"].items():
            mine[m].append(s)
    theirs: Dict[str, List[float]] = defaultdict(list)
    for p in first:
        for m, s in p["scores"].items():
            theirs[m].append(s)
    print(f"\n| model | first judge | {args.judge} judge |\n|---|---|---|")
    for m in models:
        a, b = mean(theirs[m]), mean(mine[m])
        print(f"| {m} | {a:.2f} | {b:.2f} |" if a is not None and b is not None else f"| {m} | n/a | n/a |")
    print(f"\nwrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
