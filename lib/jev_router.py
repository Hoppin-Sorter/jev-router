"""Jev routing for any agent.

One Jev call judges how hard a prompt is, what it is about and what kind of output it
wants; code then picks the model, the reasoning effort that goes with it, and which of
your skills (if any) fits. A focus setting (0 = token efficient ... 4 = task focused)
trades quality against cost. Standard library only (Python 3.9+). Mirrors
lib/jev-router.ts, which the Claude Code plugin uses, so every surface routes the same way.

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
SUBJECTS = ("software", "science", "math", "data", "writing", "business", "general")
OUTPUTS = ("code_change", "explanation", "long_writing", "quick_answer", "plan_or_decision", "analysis")

TIER_RUBRIC = {
    "mechanical": "Lookups, renames, formatting, typo fixes, running a known command, or a quick factual question. Almost no reasoning; a mistake would be obvious and cheap.",
    "routine": "Everyday development: implement a clearly specified feature, fix a bug whose cause is known, write tests, explain code, or edit a few files following existing patterns.",
    "complex": "Ambiguous or multi-part work: debugging with an unclear cause, refactors across modules, design decisions, integrating an unfamiliar API, or reviewing code for subtle bugs.",
    "deep": "Hard open-ended problems: system architecture, novel algorithms, security or concurrency analysis, long multi-step research, or work where a subtle error is costly.",
}
SUBJECT_RUBRIC = {
    "software": "Writing, fixing, reviewing or explaining code, tooling or infrastructure",
    "science": "Chemistry, biology, physics, medicine or other natural-science reasoning",
    "math": "Proofs, derivations, or quantitative and statistical reasoning",
    "data": "Analyzing datasets, SQL, spreadsheets or charts",
    "writing": "Drafting or editing prose: emails, essays, docs, marketing copy",
    "business": "Strategy, pricing, finance, legal, product or operations decisions",
    "general": "Everyday questions or chat that fit none of the above",
}
OUTPUT_RUBRIC = {
    "code_change": "Edits or new code in a codebase",
    "explanation": "Teaching or explaining how or why something works",
    "long_writing": "A finished piece of prose meant for others to read",
    "quick_answer": "A short factual answer or one-line fix",
    "plan_or_decision": "A recommendation, plan, design or decision with trade-offs",
    "analysis": "Working through data, evidence or calculations to a result",
}

# How sure Jev must be that a tier is enough (balanced focus). The cheapest tier whose
# cumulative probability clears its bar wins, so uncertainty rounds up, never down.
ENOUGH = {"mechanical": 0.85, "routine": 0.7, "complex": 0.5, "deep": 0.0}
RISK_FLOOR = 0.7
SKILL_MIN = 0.5
LABEL_MIN = 0.5  # a subject or output answer below this confidence is ignored
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

# A model that beats the tier's default for one subject. Premium ones cost more and sit
# out at low focus. Only where public evidence supports it: Fable 5.1 leads graduate-level
# science (GPQA Diamond ~93%); elsewhere Opus and Sonnet match or beat it for less, so
# every other cell keeps the tier default until your own eval (eval/) says otherwise.
CLAUDE_SPECIALISTS = {
    "science": {"deep": {"model": "claude-fable-5-1", "premium": True}},
    "math": {"deep": {"model": "claude-fable-5-1", "premium": True}},
}

PRESETS = {
    "anthropic": {"models": DEFAULT_MODELS, "efforts": TIER_EFFORT, "specialists": CLAUDE_SPECIALISTS},
    "openai": {"models": OPENAI_MODELS, "efforts": OPENAI_EFFORT, "specialists": {}},
}

FOCUS_LABELS = {0: "Token efficient", 1: "Lean", 2: "Balanced", 3: "Thorough", 4: "Task focused"}
# What each focus level changes: how sure Jev must be before a cheaper tier wins, a
# minimum tier, a shift in reasoning effort, and whether premium specialists may be used.
FOCUS = {
    0: {"enough": {"mechanical": 0.6, "routine": 0.5, "complex": 0.35, "deep": 0.0}, "min_tier": None, "effort_shift": -1, "specialists": False},
    1: {"enough": {"mechanical": 0.75, "routine": 0.6, "complex": 0.42, "deep": 0.0}, "min_tier": None, "effort_shift": 0, "specialists": False},
    2: {"enough": ENOUGH, "min_tier": None, "effort_shift": 0, "specialists": True},
    3: {"enough": {"mechanical": 0.92, "routine": 0.8, "complex": 0.6, "deep": 0.0}, "min_tier": None, "effort_shift": 0, "specialists": True},
    4: {"enough": {"mechanical": 0.97, "routine": 0.88, "complex": 0.7, "deep": 0.0}, "min_tier": "routine", "effort_shift": 1, "specialists": True},
}
DEFAULT_FOCUS = 2
FOCUS_NAMES = {"token-efficient": 0, "efficient": 0, "lean": 1, "balanced": 2, "thorough": 3, "task-focused": 4, "task": 4}

EFFORT_LADDER = ("low", "medium", "high", "xhigh", "max")
PROMPT_CHARS = 6000
DESCRIPTION_CHARS = 200
MAX_SKILLS = 254  # a Choice takes 255 options; one is `none`


def _rank(tier: str) -> int:
    return TIERS.index(tier)


def _pct(p: Optional[float]) -> str:
    return f"{round((p or 0) * 100)}%"


def pick_tier(probabilities: Mapping[str, float], enough: Mapping[str, float] = ENOUGH) -> str:
    total = 0.0
    for tier in TIERS:
        total += probabilities.get(tier, 0.0)
        if total >= enough[tier]:
            return tier
    return "deep"


def shift_effort(effort: Optional[str], by: int) -> Optional[str]:
    """Moves an effort up or down the low..max ladder. None (no effort setting) stays None; low is the floor."""
    if not effort or by == 0 or effort not in EFFORT_LADDER:
        return effort
    i = max(0, min(len(EFFORT_LADDER) - 1, EFFORT_LADDER.index(effort) + by))
    return EFFORT_LADDER[i]


def build_request(prompt: str, *, tier: bool = True, classify: Optional[bool] = None, skills: Iterable[Mapping[str, str]] = ()) -> dict:
    """The Jev request body: tier and risk questions (plus subject and output type unless
    `classify` is False), and a skill question when skills are given. All run in one call."""
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
    if tier if classify is None else classify:
        questions["subject"] = {"type": "choice", "instructions": "Which subject area is `user_message` mainly about?", "criteria": SUBJECT_RUBRIC}
        questions["output"] = {"type": "choice", "instructions": "What kind of output does `user_message` ask for?", "criteria": OUTPUT_RUBRIC}
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


def _label(answer: Optional[Mapping], allowed: Tuple[str, ...]) -> Optional[str]:
    if answer and answer["choice"] in allowed and answer["probabilities"].get(answer["choice"], 0.0) >= LABEL_MIN:
        return answer["choice"]
    return None


@dataclass
class Decision:
    tier: Optional[str]
    subject: Optional[str]
    output: Optional[str]
    skill: Optional[str]
    why: str


def decide(answers: Mapping, held: Optional[str] = None, focus: int = DEFAULT_FOCUS) -> Decision:
    """Turns Jev's answers into a Decision. The tier never drops below `held`."""
    rule = FOCUS[focus]
    subject = _label(answers.get("subject"), SUBJECTS)
    output = _label(answers.get("output"), OUTPUTS)
    tier: Optional[str] = None
    why = ""
    if answers.get("tier"):
        probs = answers["tier"]["probabilities"]
        choice = answers["tier"]["choice"]
        tier = pick_tier(probs, rule["enough"])
        why = f"Jev said {choice} ({_pct(probs.get(choice))})"
        if subject:
            why += f", {subject}"
        if rule["min_tier"] and _rank(tier) < _rank(rule["min_tier"]):
            tier = rule["min_tier"]
            why += ", task focus floor"
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
    return Decision(tier, subject, output, skill, why)


def choose(plan: Mapping, tier: str, *, subject: Optional[str] = None, output: Optional[str] = None, focus: int = DEFAULT_FOCUS) -> Tuple[str, Optional[str], bool]:
    """(model, effort, specialist): the subject's specialist when there is one (premium ones only
    from balanced focus up), else the tier's model. Effort follows the tier, moved by the focus
    level and down one step for quick answers."""
    rule = FOCUS[focus]
    spec = ((plan.get("specialists") or {}).get(subject) or {}).get(tier) if subject else None
    use_spec = bool(spec) and (not spec.get("premium") or rule["specialists"])
    shift = rule["effort_shift"] + (-1 if output == "quick_answer" else 0)
    model = spec["model"] if use_spec else plan["models"][tier]
    return model, shift_effort(plan["efforts"][tier], shift), use_spec


def parse_focus(value) -> int:
    """0-4, or a name: token-efficient, lean, balanced, thorough, task-focused."""
    if isinstance(value, int) and value in FOCUS:
        return value
    text = str(value).strip().lower()
    if text.isdigit() and int(text) in FOCUS:
        return int(text)
    if text in FOCUS_NAMES:
        return FOCUS_NAMES[text]
    raise ValueError(f"focus must be 0-4 or one of {', '.join(sorted(FOCUS_NAMES))}")


@dataclass
class Route:
    tier: str
    model: str  # model ID to send the request to
    effort: Optional[str]  # Claude output_config.effort / OpenAI reasoning.effort; None = send none
    subject: Optional[str]  # what the prompt is about, when Jev was sure enough
    output: Optional[str]  # what kind of output it wants
    specialist: bool  # True when a subject specialist (e.g. Fable for hard science) replaced the tier's model
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
        focus=DEFAULT_FOCUS,
        models: Optional[Mapping[str, str]] = None,
        efforts: Optional[Mapping[str, Optional[str]]] = None,
        specialists: Optional[Mapping] = None,
        hold_seconds: float = 600,
        timeout: float = 3.0,
        fallback: str = "complex",
    ):
        self._api_key = api_key
        self.skills = list(skills)
        preset = PRESETS[provider]
        self.plan = {
            "models": {**preset["models"], **(models or {})},
            "efforts": {**preset["efforts"], **(efforts or {})},
            "specialists": preset["specialists"] if specialists is None else specialists,
        }
        self.focus = parse_focus(focus)
        self.hold_seconds = hold_seconds
        self.timeout = timeout
        self.fallback = fallback
        # The held tier, and the specialist model when the task started on one, so a
        # follow-up like "yes, go ahead" stays on the model that planned the work.
        self._held: Optional[Tuple[str, float, Optional[str]]] = None

    def set_focus(self, focus) -> None:
        """Change the quality/cost trade-off for later prompts."""
        self.focus = parse_focus(focus)
        if self._held:
            self._held = (self._held[0], self._held[1], None)

    def _post(self, body: dict) -> dict:
        req = urllib.request.Request(
            JEV_URL,
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as res:
            return json.load(res)

    def _result(self, tier: str, routed: bool, why: str, d: Optional[Decision] = None, keep: Optional[str] = None) -> Route:
        subject, output, skill = (d.subject, d.output, d.skill) if d else (None, None, None)
        model, effort, specialist = choose(self.plan, tier, subject=subject, output=output, focus=self.focus)
        if specialist:
            why += f", {subject} specialist"
        elif keep:
            model, specialist = keep, True
            why += f", held on {keep}"
        return Route(tier, model, effort, subject, output, specialist, skill, routed, why)

    def route(self, prompt: str) -> Route:
        now = time.monotonic()
        if self._held and (self.hold_seconds == 0 or now - self._held[1] > self.hold_seconds):
            self._held = None
        held, held_model = (self._held[0], self._held[2]) if self._held else (None, None)
        fallback = held or self.fallback

        try:
            answers = self._post(build_request(prompt, skills=self.skills)).get("answers") or {}
        except urllib.error.HTTPError as err:
            return self._result(fallback, False, f"Jev HTTP {err.code}", keep=held_model)
        except Exception as err:  # network error, timeout, bad JSON: route to the fallback
            return self._result(fallback, False, f"Jev unavailable: {err}", keep=held_model)

        d = decide(answers, held, self.focus)
        if not d.tier:
            return self._result(fallback, False, "Jev returned no tier", keep=held_model)
        r = self._result(d.tier, True, d.why, d, keep=held_model if d.tier == held else None)
        if self.hold_seconds > 0:
            self._held = (d.tier, now, r.model if r.specialist else None)
        return r

    def reset(self) -> None:
        """Forget the held tier, e.g. when the user starts a new task."""
        self._held = None


# ---- command line -------------------------------------------------------------------------


def shared_focus(home: Optional[str] = None) -> Optional[int]:
    """The focus the menu bar widget or the plugin last saved in ~/.config/jev/settings.json, if any."""
    path = os.path.join(home or os.path.expanduser("~"), ".config", "jev", "settings.json")
    try:
        with open(path) as f:
            focus = json.load(f).get("focus")
    except (OSError, ValueError, AttributeError):
        return None
    return focus if isinstance(focus, int) and not isinstance(focus, bool) and focus in FOCUS_LABELS else None


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
    ap.add_argument("--focus", default=None, help="0-4 or token-efficient | lean | balanced | thorough | task-focused (default: the focus saved in ~/.config/jev/settings.json, else balanced)")
    ap.add_argument("--skills-dir", action="append", default=None, metavar="DIR", help="folder of <name>/SKILL.md skills for Jev to pick from (repeatable; default ~/.codex/skills)")
    ap.add_argument("--run", choices=["codex", "codex-exec"], help="launch Codex with the chosen model and effort instead of printing")
    args = ap.parse_args(argv)
    if args.focus is None:
        saved = shared_focus()
        focus = DEFAULT_FOCUS if saved is None else saved
    else:
        try:
            focus = parse_focus(args.focus)
        except ValueError as err:
            ap.error(str(err))

    prompt = " ".join(args.prompt).strip() or (sys.stdin.read().strip() if not sys.stdin.isatty() else "")
    if not prompt:
        ap.error("give a prompt as arguments or on stdin")
    key = load_api_key()
    if not key:
        print("No Jev key. Set TYPESAFE_API_KEY, or save it to ~/.config/jev/api_key (see README).", file=sys.stderr)
        return 2

    skills = load_skills(args.skills_dir or ["~/.codex/skills"])
    route = Router(key, skills=skills, provider=args.provider, focus=focus).route(prompt)
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
