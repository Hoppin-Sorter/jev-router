// Jev routing for any agent: one Jev call decides which Claude model a prompt
// needs, the reasoning effort that goes with it, and which of your skills (if any)
// fits. No dependencies; runs anywhere with `fetch` (Node 18+, Bun, Deno).
//
// The jev-router Claude Code plugin imports the rubric, thresholds and decision
// logic from this file, so the plugin and any agent using it route the same way.

export type Tier = 'mechanical' | 'routine' | 'complex' | 'deep'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Skill = { name: string; description: string }

export type ChoiceAnswer = { choice: string; probabilities: Record<string, number> }
export type JevAnswers = { tier?: ChoiceAnswer; risky?: { noul: number }; skill?: ChoiceAnswer }

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const TIERS: readonly Tier[] = ['mechanical', 'routine', 'complex', 'deep']

export const TIER_RUBRIC: Record<Tier, string> = {
  mechanical:
    'Lookups, renames, formatting, typo fixes, running a known command, or a quick factual question. Almost no reasoning; a mistake would be obvious and cheap.',
  routine:
    'Everyday development: implement a clearly specified feature, fix a bug whose cause is known, write tests, explain code, or edit a few files following existing patterns.',
  complex:
    'Ambiguous or multi-part work: debugging with an unclear cause, refactors across modules, design decisions, integrating an unfamiliar API, or reviewing code for subtle bugs.',
  deep: 'Hard open-ended problems: system architecture, novel algorithms, security or concurrency analysis, long multi-step research, or work where a subtle error is costly.',
}

// How sure Jev must be that a tier is enough. The cheapest tier whose cumulative
// probability clears its bar wins, so uncertainty always rounds up, never down.
export const ENOUGH: Record<Tier, number> = { mechanical: 0.85, routine: 0.7, complex: 0.5, deep: 0 }
export const RISK_FLOOR = 0.7
export const SKILL_MIN = 0.5
// Reasoning effort that goes with each tier. Haiku takes no effort setting.
export const TIER_EFFORT: Record<Tier, Effort | null> = {
  mechanical: null,
  routine: 'medium',
  complex: 'high',
  deep: 'xhigh',
}
// Claude API model IDs. The Claude Code plugin uses its own (Claude Code's) IDs.
export const DEFAULT_MODELS: Record<Tier, string> = {
  mechanical: 'claude-haiku-4-5',
  routine: 'claude-sonnet-5-5',
  complex: 'claude-opus-5-5',
  deep: 'claude-opus-5-5',
}

const PROMPT_CHARS = 6_000
const DESCRIPTION_CHARS = 200
const MAX_SKILLS = 254 // a Choice takes 255 options; one is `none`

export const rank = (tier: Tier) => TIERS.indexOf(tier)
const pct = (p: number | undefined) => `${Math.round((p ?? 0) * 100)}%`

export function pickTier(probabilities: Record<string, number>): Tier {
  let enough = 0
  for (const tier of TIERS) {
    enough += probabilities[tier] ?? 0
    if (enough >= ENOUGH[tier]) return tier
  }
  return 'deep'
}

/** The Jev request body: the tier and risk questions, plus a skill question when skills are given. */
export function buildRequest(prompt: string, opts: { tier?: boolean; skills?: readonly Skill[] } = {}) {
  const questions: Record<string, unknown> = {}
  if (opts.tier !== false) {
    questions.tier = {
      type: 'choice',
      instructions:
        'How capable a model does a coding agent need to handle `user_message` well? Judge the difficulty of the work it asks for, not the length of the message.',
      criteria: TIER_RUBRIC,
    }
    questions.risky = {
      type: 'noul',
      instructions:
        'Could carrying out `user_message` affect production systems, credentials or secrets, permissions, billing, or delete data that may not be recoverable?',
      criteria: {
        true: 'It touches production, secrets, permissions, money, or irreversible deletion',
        false: 'Local, reversible work',
      },
    }
  }
  const skills = (opts.skills ?? []).slice(0, MAX_SKILLS)
  if (skills.length) {
    const criteria: Record<string, string> = {
      none: 'No listed skill clearly fits; the agent should just do the work itself.',
    }
    for (const s of skills) criteria[s.name] = s.description.slice(0, DESCRIPTION_CHARS)
    questions.skill = {
      type: 'choice',
      instructions:
        'Which one skill should a coding agent load to handle `user_message`? Pick `none` unless a skill description clearly matches what the message asks for.',
      criteria,
    }
  }
  return { model: 'jev-latest', state: { user_message: prompt.slice(0, PROMPT_CHARS) }, questions }
}

/**
 * Turns Jev's answers into a decision. `held` is the tier already in use for this
 * task: the result never drops below it, so follow-ups stay on the same model.
 */
export function decide(answers: JevAnswers, held?: Tier): { tier?: Tier; skill?: { name: string; p: number }; why: string } {
  let tier: Tier | undefined
  let why = ''
  if (answers.tier) {
    tier = pickTier(answers.tier.probabilities)
    why = `Jev said ${answers.tier.choice} (${pct(answers.tier.probabilities[answers.tier.choice])})`
    if ((answers.risky?.noul ?? 0) >= RISK_FLOOR && rank(tier) < rank('complex')) {
      tier = 'complex'
      why += `, risky (${pct(answers.risky?.noul)})`
    }
    if (held && rank(held) > rank(tier)) {
      why += `, held at ${held}`
      tier = held
    }
  }
  const pick = answers.skill
  const p = pick?.probabilities[pick.choice] ?? 0
  const skill = pick && pick.choice !== 'none' && p >= SKILL_MIN ? { name: pick.choice, p } : undefined
  return { tier, skill, why }
}

export type RouterOptions = {
  /** Your own TypeSafe key. */
  apiKey: string
  /** Skills the agent can load; Jev picks at most one per prompt. */
  skills?: readonly Skill[]
  /** Override the model for any tier. */
  models?: Partial<Record<Tier, string>>
  /** How long a task holds its tier against downgrades (ms). 0 turns holding off. Default 10 min. */
  holdMs?: number
  /** Give up on Jev after this long (ms) and use `fallback`. Default 3000. */
  timeoutMs?: number
  /** Tier to use when Jev can't answer. Default `complex`. */
  fallback?: Tier
  fetch?: typeof fetch
  now?: () => number
}

export type Route = {
  tier: Tier
  /** Claude model ID to send the request to. */
  model: string
  /** Reasoning effort for `output_config.effort`; null for Haiku, which takes none. */
  effort: Effort | null
  /** Name of the skill Jev picked, or null. */
  skill: string | null
  /** False when Jev couldn't answer and `fallback` was used. */
  routed: boolean
  why: string
}

/** A router for one conversation or agent loop. Call `route()` with each new user prompt. */
export function createRouter(options: RouterOptions) {
  const models = { ...DEFAULT_MODELS, ...options.models }
  const holdMs = options.holdMs ?? 10 * 60_000
  const now = options.now ?? Date.now
  const doFetch = options.fetch ?? fetch
  let held: { tier: Tier; at: number } | undefined

  const result = (tier: Tier, routed: boolean, why: string, skill: string | null = null): Route => ({
    tier,
    model: models[tier],
    effort: TIER_EFFORT[tier],
    skill,
    routed,
    why,
  })

  return {
    async route(prompt: string): Promise<Route> {
      const t = now()
      if (held && (holdMs === 0 || t - held.at > holdMs)) held = undefined
      const fallback = held?.tier ?? options.fallback ?? 'complex'

      let answers: JevAnswers
      try {
        const res = await doFetch(JEV_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildRequest(prompt, { skills: options.skills })),
          signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
        })
        if (!res.ok) return result(fallback, false, `Jev HTTP ${res.status}`)
        answers = ((await res.json()) as { answers?: JevAnswers }).answers ?? {}
      } catch (err) {
        return result(fallback, false, `Jev unavailable: ${err instanceof Error ? err.message : 'request failed'}`)
      }

      const d = decide(answers, held?.tier)
      if (!d.tier) return result(fallback, false, 'Jev returned no tier')
      if (holdMs > 0) held = { tier: d.tier, at: t }
      return result(d.tier, true, d.why, d.skill?.name ?? null)
    },
    /** Forget the held tier, e.g. when the user starts a new task. */
    reset() {
      held = undefined
    },
  }
}
