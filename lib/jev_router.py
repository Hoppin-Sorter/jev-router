"""Jev routing for any agent.

One Jev call decides which Claude model a prompt needs, the reasoning effort that
goes with it, and which of your skills (if any) fits. Standard library only
(Python 3.9+). Mirrors lib/jev-router.ts, which the Claude Code plugin uses, so
both route the same way.

    from jev_router import Router

    router = Router(api_key=os.environ["TYPESAFE_API_KEY"], skills=[...])
    r = router.route(user_message)
    # send the request to r.model; pass r.effort as output_config.effort if set
"""

from __future__ import annotations

import json
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
    model: str  # Claude model ID to send the request to
    effort: Optional[str]  # for output_config.effort; None for Haiku, which takes none
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
        models: Optional[Mapping[str, str]] = None,
        hold_seconds: float = 600,
        timeout: float = 3.0,
        fallback: str = "complex",
    ):
        self._api_key = api_key
        self.skills = list(skills)
        self.models = {**DEFAULT_MODELS, **(models or {})}
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
        return Route(tier, self.models[tier], TIER_EFFORT[tier], skill, routed, why)

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
