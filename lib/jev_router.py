"""Jev routing for any agent.

One Jev call decides which Claude model a prompt needs, the reasoning effort that
goes with it, and which of your skills (if any) fits. Standard library only
(Python 3.9+). Mirrors lib/jev-router.ts, which the Claude Code plugin uses, so
both route the same way.

    from jev_router import Router

    router = Router(api_key=os.environ["TYPESAFE_API_KEY"], skills=[...])   # provider="openai" for GPT
    r = router.route(user_message)
    # send the request to r.model; pass r.effort as the reasoning effort if set

It is also a command: `python3 jev_router.py --provider openai --run codex-exec "fix the bug"`
picks the model and effort for one Codex run. See `--help`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Dict, Iterable, Mapping, Optional, Tuple

JEV_URL = "https://api.typesafe.ai/v1/systemone"
TIERS = ("mechanical", "routine", "complex", "deep")

TIER_RUBRIC = {
    "mechanical": "Lookups, renames, formatting, typo fixes, running a known command, or a quick factual question. Almost no reasoning; a mistake would be obvious and cheap.",
    "routine": "Everyday development: implement a clearly specified feature, fix a bug whose cause is known, write tests, explain code, or edit a few files following existing patterns.",
    "complex": "Ambiguous or multi-part work: debugging with an unclear cause, refactors across modules, design decisions, integrating an unfamiliar API, or reviewing code for subtle bugs.",
    "deep": "Hard open-ended problems: system architecture, novel algorithms, security or concurrency analysis, long multi-step research, or work where a subtle error is costly.",
}

# How sure Jev must be that a tier is enough. The cheapest tier whose cumulative
# probability clears its bar wins, so uncertainty always rounds up, never down.
ENOUGH = {"mechanical": 0.85, "routine": 0.7, "complex": 0.5, "deep": 0.0}
RISK_FLOOR = 0.7
SKILL_MIN = 0.5
# Reasoning effort that goes with each tier. Haiku takes no effort setting.
TIER_EFFORT = {"mechanical": None, "routine": "medium", "complex": "high", "deep": "xhigh"}
DEFAULT_MODELS = {
    "mechanical": "claude-haiku-4-5",
    "routine": "claude-sonnet-5-5",
    "complex": "claude-opus-5-5",
    "deep": "claude-opus-5-5",
}

# OpenAI presets (Responses API `reasoning.effort`, Chat Completions `reasoning_effort`,
# Codex `model_reasoning_effort`). Every pairing is valid for its model: Luna accepts
# none..max, Sol and Astra accept low..max. Move `complex` to Sol with `models=` to spend less.
OPENAI_MODELS = {
    "mechanical": "gpt-6-luna",
    "routine": "gpt-6.1-sol",
    "complex": "gpt-6-astra",
    "deep": "gpt-6-astra",
}
OPENAI_EFFORT = {"mechanical": "low", "routine": "medium", "complex": "high", "deep": "xhigh"}

PRESETS = {
    "anthropic": (DEFAULT_MODELS, TIER_EFFORT),
    "openai": (OPENAI_MODELS, OPENAI_EFFORT),
}

PROMPT_CHARS = 6000
DESCRIPTION_CHARS = 200
MAX_SKILLS = 254  # a Choice takes 255 options; one is `none`


def _rank(tier: str) -> int:
    return TIERS.index(tier)


def _pct(p: Optional[float]) -> str:
    return f"{round((p or 0) * 100)}%"


def pick_tier(probabilities: Mapping[str, float]) -> str:
    enough = 0.0
    for tier in TIERS:
        enough += probabilities.get(tier, 0.0)
        if enough >= ENOUGH[tier]:
            return tier
    return "deep"


def build_request(prompt: str, *, tier: bool = True, skills: Iterable[Mapping[str, str]] = ()) -> dict:
    """The Jev request body: tier and risk questions, plus a skill question when skills are given."""
    questions: Dict[str, dict] = {}
    if tier:
        questions["tier"] = {
            "type": "choice",
            "instructions": "How capable a model does a coding agent need to handle `user_message` well? Judge the difficulty of the work it asks for, not the length of the message.",
            "criteria": TIER_RUBRIC,
        }
        questions["risky"] = {
            "type": "noul",
            "instructions": "Could carrying out `user_message` affect production systems, credentials or secrets, permissions, billing, or delete data that may not be recoverable?",
            "criteria": {
                "true": "It touches production, secrets, permissions, money, or irreversible deletion",
                "false": "Local, reversible work",
            },
        }
    skills = list(skills)[:MAX_SKILLS]
    if skills:
        criteria = {"none": "No listed skill clearly fits; the agent should just do the work itself."}
        for s in skills:
            criteria[s["name"]] = s["description"][:DESCRIPTION_CHARS]
        questions["skill"] = {
            "type": "choice",
            "instructions": "Which one skill should a coding agent load to handle `user_message`? Pick `none` unless a skill description clearly matches what the message asks for.",
            "criteria": criteria,
        }
    return {"model": "jev-latest", "state": {"user_message": prompt[:PROMPT_CHARS]}, "questions": questions}


def decide(answers: Mapping, held: Optional[str] = None) -> Tuple[Optional[str], Optional[str], str]:
    """Turns Jev's answers into (tier, skill, why). The tier never drops below `held`."""
    tier: Optional[str] = None
    why = ""
    if answers.get("tier"):
        probs = answers["tier"]["probabilities"]
        choice = answers["tier"]["choice"]
        tier = pick_tier(probs)
        why = f"Jev said {choice} ({_pct(probs.get(choice))})"
        risky = (answers.get("risky") or {}).get("noul", 0.0)
        if risky >= RISK_FLOOR and _rank(tier) < _rank("complex"):
            tier = "complex"
            why += f", risky ({_pct(risky)})"
        if held and _rank(held) > _rank(tier):
            why += f", held at {held}"
            tier = held
    skill = None
    pick = answers.get("skill")
    if pick and pick["choice"] != "none" and pick["probabilities"].get(pick["choice"], 0.0) >= SKILL_MIN:
        skill = pick["choice"]
    return tier, skill, why


@dataclass
class Route:
    tier: str
    model: str  # model ID to send the request to
    effort: Optional[str]  # Claude output_config.effort / OpenAI reasoning.effort; None = send none
    skill: Optional[str]  # name of the skill Jev picked, or None
    routed: bool  # False when Jev couldn't answer and the fallback was used
    why: str


class Router:
    """A router for one conversation or agent loop. Call route() with each new user prompt."""

    def __init__(
        self,
        api_key: str,
        *,
        skills: Iterable[Mapping[str, str]] = (),
        provider: str = "anthropic",
        models: Optional[Mapping[str, str]] = None,
        efforts: Optional[Mapping[str, Optional[str]]] = None,
        hold_seconds: float = 600,
        timeout: float = 3.0,
        fallback: str = "complex",
    ):
        self._api_key = api_key
        self.skills = list(skills)
        preset_models, preset_efforts = PRESETS[provider]
        self.models = {**preset_models, **(models or {})}
        self.efforts = {**preset_efforts, **(efforts or {})}
        self.hold_seconds = hold_seconds
        self.timeout = timeout
        self.fallback = fallback
        self._held: Optional[Tuple[str, float]] = None

    def _post(self, body: dict) -> dict:
        req = urllib.request.Request(
            JEV_URL,
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as res:
            return json.load(res)

    def _result(self, tier: str, routed: bool, why: str, skill: Optional[str] = None) -> Route:
        return Route(tier, self.models[tier], self.efforts[tier], skill, routed, why)

    def route(self, prompt: str) -> Route:
        now = time.monotonic()
        if self._held and (self.hold_seconds == 0 or now - self._held[1] > self.hold_seconds):
            self._held = None
        held = self._held[0] if self._held else None
        fallback = held or self.fallback

        try:
            answers = self._post(build_request(prompt, skills=self.skills)).get("answers") or {}
        except urllib.error.HTTPError as err:
            return self._result(fallback, False, f"Jev HTTP {err.code}")
        except Exception as err:  # network error, timeout, bad JSON: route to the fallback
            return self._result(fallback, False, f"Jev unavailable: {err}")

        tier, skill, why = decide(answers, held)
        if not tier:
            return self._result(fallback, False, "Jev returned no tier")
        if self.hold_seconds > 0:
            self._held = (tier, now)
        return self._result(tier, True, why, skill)

    def reset(self) -> None:
        """Forget the held tier, e.g. when the user starts a new task."""
        self._held = None


# ---- command line -------------------------------------------------------------------------


def load_api_key(env: Optional[Mapping[str, str]] = None, home: Optional[str] = None) -> Optional[str]:
    """TYPESAFE_API_KEY, then JEV_API_KEY, then ~/.config/jev/api_key (the plugin reads the same places)."""
    env = os.environ if env is None else env
    for name in ("TYPESAFE_API_KEY", "JEV_API_KEY"):
        if env.get(name, "").strip():
            return env[name].strip()
    path = os.path.join(home or os.path.expanduser("~"), ".config", "jev", "api_key")
    try:
        with open(path) as f:
            return f.read().strip() or None
    except OSError:
        return None


def load_skills(dirs: Iterable[str]) -> list:
    """Reads `name` and `description` from the front matter of each <dir>/*/SKILL.md."""
    skills, seen = [], set()
    for d in dirs:
        d = os.path.expanduser(d)
        if not os.path.isdir(d):
            continue
        for entry in sorted(os.listdir(d)):
            path = os.path.join(d, entry, "SKILL.md")
            try:
                with open(path, errors="ignore") as f:
                    text = f.read(6000)
            except OSError:
                continue
            m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
            if not m:
                continue
            name = re.search(r"^name:\s*(.+)$", m.group(1), re.M)
            desc = re.search(r"^description:\s*(.*?)(?=\n[A-Za-z_-]+:|\Z)", m.group(1), re.S | re.M)
            if not name or not desc:
                continue
            description = re.sub(r"\s+", " ", re.sub(r"^[>|][-+0-9]*\s*", "", desc.group(1).strip()))
            n = name.group(1).strip().strip("\"'")
            if description and n not in seen:
                seen.add(n)
                skills.append({"name": n, "description": description})
    return skills


def codex_argv(route: Route, prompt: str, *, interactive: bool) -> list:
    """The Codex command for this route: `codex [exec] -m MODEL -c model_reasoning_effort="EFFORT" PROMPT`."""
    argv = ["codex"] if interactive else ["codex", "exec"]
    argv += ["-m", route.model]
    if route.effort:
        argv += ["-c", f'model_reasoning_effort="{route.effort}"']
    if route.skill:
        prompt = f'(Jev suggests the "{route.skill}" skill for this request; use it if it fits.)\n\n{prompt}'
    return argv + [prompt]


def main(argv: Optional[list] = None, *, runner=None) -> int:
    ap = argparse.ArgumentParser(
        prog="jev_router.py",
        description="Ask Jev which model (and reasoning effort) a prompt needs; print it, or launch Codex with it.",
    )
    ap.add_argument("prompt", nargs="*", help="the prompt (reads stdin when omitted)")
    ap.add_argument("--provider", choices=sorted(PRESETS), default="openai", help="whose models to pick from (default: openai)")
    ap.add_argument("--skills-dir", action="append", default=None, metavar="DIR", help="folder of <name>/SKILL.md skills for Jev to pick from (repeatable; default ~/.codex/skills)")
    ap.add_argument("--run", choices=["codex", "codex-exec"], help="launch Codex with the chosen model and effort instead of printing")
    args = ap.parse_args(argv)

    prompt = " ".join(args.prompt).strip() or (sys.stdin.read().strip() if not sys.stdin.isatty() else "")
    if not prompt:
        ap.error("give a prompt as arguments or on stdin")
    key = load_api_key()
    if not key:
        print("No Jev key. Set TYPESAFE_API_KEY, or save it to ~/.config/jev/api_key (see README).", file=sys.stderr)
        return 2

    skills = load_skills(args.skills_dir or ["~/.codex/skills"])
    route = Router(key, skills=skills, provider=args.provider).route(prompt)
    if not route.routed:
        print(f"warning: {route.why}; using the fallback tier", file=sys.stderr)

    if args.run:
        cmd = codex_argv(route, prompt, interactive=args.run == "codex")
        print(f"jev: {route.model}" + (f" · {route.effort}" if route.effort else "") + f"  ({route.why})", file=sys.stderr)
        (runner or (lambda a: os.execvp(a[0], a)))(cmd)
        return 0
    print(json.dumps(route.__dict__))
    return 0


if __name__ == "__main__":
    sys.exit(main())
