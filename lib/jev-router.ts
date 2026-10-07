// Jev routing for any agent: one Jev call judges how hard a prompt is, what it is
// about and what kind of output it wants; code then picks the model, the reasoning
// effort that goes with it, and which of your skills (if any) fits. A focus setting
// trades quality against cost. No dependencies; runs anywhere with `fetch` (Node 18+,
// Bun, Deno).
//
// The jev-router Claude Code plugin imports everything below except createRouter,
// and lib/jev_router.py mirrors it, so every surface routes the same way.

export type Tier = 'mechanical' | 'routine' | 'complex' | 'deep'
export type Subject = 'software' | 'science' | 'math' | 'data' | 'writing' | 'business' | 'general'
export type Output = 'code_change' | 'explanation' | 'long_writing' | 'quick_answer' | 'plan_or_decision' | 'analysis'
/** 0 = token efficient … 4 = task focused. */
export type Focus = 0 | 1 | 2 | 3 | 4
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Provider = 'anthropic' | 'openai'
export type Skill = { name: string; description: string }

export type ChoiceAnswer = { choice: string; probabilities: Record<string, number> }
export type JevAnswers = {
  tier?: ChoiceAnswer
  risky?: { noul: number }
  subject?: ChoiceAnswer
  output?: ChoiceAnswer
  skill?: ChoiceAnswer
}

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const TIERS: readonly Tier[] = ['mechanical', 'routine', 'complex', 'deep']
export const SUBJECTS: readonly Subject[] = ['software', 'science', 'math', 'data', 'writing', 'business', 'general']
export const OUTPUTS: readonly Output[] = ['code_change', 'explanation', 'long_writing', 'quick_answer', 'plan_or_decision', 'analysis']

export const TIER_RUBRIC: Record<Tier, string> = {
  mechanical:
    'Lookups, renames, formatting, typo fixes, running a known command, or a quick factual question. Almost no reasoning; a mistake would be obvious and cheap.',
  routine:
    'Everyday development: implement a clearly specified feature, fix a bug whose cause is known, write tests, explain code, or edit a few files following existing patterns.',
  complex:
    'Ambiguous or multi-part work: debugging with an unclear cause, refactors across modules, design decisions, integrating an unfamiliar API, or reviewing code for subtle bugs.',
  deep: 'Hard open-ended problems: system architecture, novel algorithms, security or concurrency analysis, long multi-step research, or work where a subtle error is costly.',
}

export const SUBJECT_RUBRIC: Record<Subject, string> = {
  software: 'Writing, fixing, reviewing or explaining code, tooling or infrastructure',
  science: 'Chemistry, biology, physics, medicine or other natural-science reasoning',
  math: 'Proofs, derivations, or quantitative and statistical reasoning',
  data: 'Analyzing datasets, SQL, spreadsheets or charts',
  writing: 'Drafting or editing prose: emails, essays, docs, marketing copy',
  business: 'Strategy, pricing, finance, legal, product or operations decisions',
  general: 'Everyday questions or chat that fit none of the above',
}

export const OUTPUT_RUBRIC: Record<Output, string> = {
  code_change: 'Edits or new code in a codebase',
  explanation: 'Teaching or explaining how or why something works',
  long_writing: 'A finished piece of prose meant for others to read',
  quick_answer: 'A short factual answer or one-line fix',
  plan_or_decision: 'A recommendation, plan, design or decision with trade-offs',
  analysis: 'Working through data, evidence or calculations to a result',
}

// How sure Jev must be that a tier is enough (balanced focus). The cheapest tier whose
// cumulative probability clears its bar wins, so uncertainty rounds up, never down.
export const ENOUGH: Record<Tier, number> = { mechanical: 0.85, routine: 0.7, complex: 0.5, deep: 0 }
export const RISK_FLOOR = 0.7
export const SKILL_MIN = 0.5
// A subject or output answer below this confidence is ignored.
export const LABEL_MIN = 0.5

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

// OpenAI presets (Responses API `reasoning.effort`, Chat Completions `reasoning_effort`,
// Codex `model_reasoning_effort`). Every pairing is valid for its model: Luna accepts
// none..max, Sol and Astra accept low..max. Move `complex` to Sol with the `models`
// option to spend less.
export const OPENAI_MODELS: Record<Tier, string> = {
  mechanical: 'gpt-6-luna',
  routine: 'gpt-6.1-sol',
  complex: 'gpt-6-astra',
  deep: 'gpt-6-astra',
}
export const OPENAI_EFFORT: Record<Tier, string | null> = {
  mechanical: 'low',
  routine: 'medium',
  complex: 'high',
  deep: 'xhigh',
}

/** A model that beats the tier's default for one subject. `premium` ones cost more and sit out at low focus. */
export type Specialist = { model: string; premium?: boolean }
export type Specialists = Partial<Record<Subject, Partial<Record<Tier, Specialist>>>>
export type ModelPlan = { models: Record<Tier, string>; efforts: Record<Tier, string | null>; specialists?: Specialists }

// Only where public evidence supports it: Fable 5.1 leads graduate-level science
// (GPQA Diamond ~93%) and Anthropic reports its biggest gains in science and
// engineering. Elsewhere Opus and Sonnet match or beat it at a lower price, so every
// other cell keeps the tier default until your own eval (eval/) says otherwise.
export const CLAUDE_SPECIALISTS: Specialists = {
  science: { deep: { model: 'claude-fable-5-1', premium: true } },
  math: { deep: { model: 'claude-fable-5-1', premium: true } },
}

export const PRESETS: Record<Provider, ModelPlan> = {
  anthropic: { models: DEFAULT_MODELS, efforts: TIER_EFFORT, specialists: CLAUDE_SPECIALISTS },
  openai: { models: OPENAI_MODELS, efforts: OPENAI_EFFORT },
}

export const FOCUS_LABELS: Record<Focus, string> = {
  0: 'Token efficient',
  1: 'Lean',
  2: 'Balanced',
  3: 'Thorough',
  4: 'Task focused',
}
/**
 * What each focus level changes: how sure Jev must be before a cheaper tier wins,
 * a minimum tier, a shift in reasoning effort, and whether premium specialists
 * (Fable) may be used. Risky prompts floor at `complex` at every level.
 */
export type FocusRule = { enough: Record<Tier, number>; minTier?: Tier; effortShift: number; specialists: boolean }
export const FOCUS: Record<Focus, FocusRule> = {
  0: { enough: { mechanical: 0.6, routine: 0.5, complex: 0.35, deep: 0 }, effortShift: -1, specialists: false },
  1: { enough: { mechanical: 0.75, routine: 0.6, complex: 0.42, deep: 0 }, effortShift: 0, specialists: false },
  2: { enough: ENOUGH, effortShift: 0, specialists: true },
  3: { enough: { mechanical: 0.92, routine: 0.8, complex: 0.6, deep: 0 }, effortShift: 0, specialists: true },
  4: { enough: { mechanical: 0.97, routine: 0.88, complex: 0.7, deep: 0 }, minTier: 'routine', effortShift: 1, specialists: true },
}
export const DEFAULT_FOCUS: Focus = 2

const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max']
const PROMPT_CHARS = 6_000
const DESCRIPTION_CHARS = 200
const MAX_SKILLS = 254 // a Choice takes 255 options; one is `none`

export const rank = (tier: Tier) => TIERS.indexOf(tier)
export const isFocus = (v: unknown): v is Focus => v === 0 || v === 1 || v === 2 || v === 3 || v === 4
const pct = (p: number | undefined) => `${Math.round((p ?? 0) * 100)}%`

export function pickTier(probabilities: Record<string, number>, enough: Record<Tier, number> = ENOUGH): Tier {
  let sum = 0
  for (const tier of TIERS) {
    sum += probabilities[tier] ?? 0
    if (sum >= enough[tier]) return tier
  }
  return 'deep'
}

/** Moves an effort up or down the low..max ladder. Null (no effort setting) stays null; low is the floor. */
export function shiftEffort(effort: string | null, by: number): string | null {
  const i = effort ? EFFORT_LADDER.indexOf(effort) : -1
  if (i < 0 || by === 0) return effort
  return EFFORT_LADDER[Math.max(0, Math.min(EFFORT_LADDER.length - 1, i + by))]!
}

/**
 * The Jev request body: tier and risk questions (plus subject and output type, unless
 * `classify` is false), and a skill question when skills are given. All run in one call.
 */
export function buildRequest(prompt: string, opts: { tier?: boolean; classify?: boolean; skills?: readonly Skill[] } = {}) {
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
  if (opts.classify ?? opts.tier !== false) {
    questions.subject = { type: 'choice', instructions: 'Which subject area is `user_message` mainly about?', criteria: SUBJECT_RUBRIC }
    questions.output = { type: 'choice', instructions: 'What kind of output does `user_message` ask for?', criteria: OUTPUT_RUBRIC }
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

const label = <T extends string>(answer: ChoiceAnswer | undefined, allowed: readonly T[]): T | undefined =>
  answer && allowed.includes(answer.choice as T) && (answer.probabilities[answer.choice] ?? 0) >= LABEL_MIN
    ? (answer.choice as T)
    : undefined

export type Decision = {
  tier?: Tier
  subject?: Subject
  output?: Output
  skill?: { name: string; p: number }
  why: string
}

/**
 * Turns Jev's answers into a decision. `held` is the tier already in use for this
 * task: the result never drops below it, so follow-ups stay on the same model.
 */
export function decide(answers: JevAnswers, opts: { held?: Tier; focus?: Focus } = {}): Decision {
  const rule = FOCUS[opts.focus ?? DEFAULT_FOCUS]
  const subject = label(answers.subject, SUBJECTS)
  const output = label(answers.output, OUTPUTS)
  let tier: Tier | undefined
  let why = ''
  if (answers.tier) {
    tier = pickTier(answers.tier.probabilities, rule.enough)
    why = `Jev said ${answers.tier.choice} (${pct(answers.tier.probabilities[answers.tier.choice])})`
    if (subject) why += `, ${subject}`
    if (rule.minTier && rank(tier) < rank(rule.minTier)) {
      tier = rule.minTier
      why += `, task focus floor`
    }
    if ((answers.risky?.noul ?? 0) >= RISK_FLOOR && rank(tier) < rank('complex')) {
      tier = 'complex'
      why += `, risky (${pct(answers.risky?.noul)})`
    }
    if (opts.held && rank(opts.held) > rank(tier)) {
      why += `, held at ${opts.held}`
      tier = opts.held
    }
  }
  const pick = answers.skill
  const p = pick?.probabilities[pick.choice] ?? 0
  const skill = pick && pick.choice !== 'none' && p >= SKILL_MIN ? { name: pick.choice, p } : undefined
  return { tier, subject, output, skill, why }
}

/**
 * Picks the model and effort for a tier: the subject's specialist when there is one
 * (premium ones only from balanced focus up), otherwise the tier's model. Effort
 * follows the tier, moved by the focus level and down one step for quick answers.
 */
export function choose(
  plan: ModelPlan,
  tier: Tier,
  opts: { subject?: Subject; output?: Output; focus?: Focus } = {},
): { model: string; effort: string | null; specialist: boolean } {
  const rule = FOCUS[opts.focus ?? DEFAULT_FOCUS]
  const spec = opts.subject ? plan.specialists?.[opts.subject]?.[tier] : undefined
  const useSpec = !!spec && (!spec.premium || rule.specialists)
  const shift = rule.effortShift + (opts.output === 'quick_answer' ? -1 : 0)
  return {
    model: useSpec ? spec!.model : plan.models[tier],
    effort: shiftEffort(plan.efforts[tier], shift),
    specialist: useSpec,
  }
}

export type RouterOptions = {
  /** Your own TypeSafe key. */
  apiKey: string
  /** Whose models to route between. Default `anthropic`. */
  provider?: Provider
  /** 0 = token efficient … 4 = task focused. Default 2 (balanced). */
  focus?: Focus
  /** Skills the agent can load; Jev picks at most one per prompt. */
  skills?: readonly Skill[]
  /** Override the model for any tier. */
  models?: Partial<Record<Tier, string>>
  /** Override the reasoning effort for any tier (null sends none). */
  efforts?: Partial<Record<Tier, string | null>>
  /** Override the per-subject specialists (pass {} for none). */
  specialists?: Specialists
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
  /** Model ID to send the request to. */
  model: string
  /** Reasoning effort: Claude `output_config.effort`, OpenAI `reasoning.effort`. Null means send none. */
  effort: string | null
  /** What the prompt is about and what it wants back, when Jev was sure enough. */
  subject: Subject | null
  output: Output | null
  /** True when a subject specialist (e.g. Fable for hard science) replaced the tier's model. */
  specialist: boolean
  /** Name of the skill Jev picked, or null. */
  skill: string | null
  /** False when Jev couldn't answer and `fallback` was used. */
  routed: boolean
  why: string
}

/** A router for one conversation or agent loop. Call `route()` with each new user prompt. */
export function createRouter(options: RouterOptions) {
  const preset = PRESETS[options.provider ?? 'anthropic']
  const plan: ModelPlan = {
    models: { ...preset.models, ...options.models },
    efforts: { ...preset.efforts, ...options.efforts },
    specialists: options.specialists ?? preset.specialists,
  }
  const holdMs = options.holdMs ?? 10 * 60_000
  const now = options.now ?? Date.now
  const doFetch = options.fetch ?? fetch
  let focus: Focus = options.focus ?? DEFAULT_FOCUS
  // The held tier, and the specialist model when the task started on one, so a
  // follow-up like "yes, go ahead" stays on the model that planned the work.
  let held: { tier: Tier; at: number; model?: string } | undefined

  const result = (tier: Tier, routed: boolean, why: string, d: Partial<Decision> = {}, keep?: string): Route => {
    const c = choose(plan, tier, { subject: d.subject, output: d.output, focus })
    let { model, specialist } = c
    if (specialist) why += `, ${d.subject} specialist`
    else if (keep) {
      model = keep
      specialist = true
      why += `, held on ${keep}`
    }
    return {
      tier,
      model,
      effort: c.effort,
      subject: d.subject ?? null,
      output: d.output ?? null,
      specialist,
      skill: d.skill?.name ?? null,
      routed,
      why,
    }
  }

  return {
    async route(prompt: string): Promise<Route> {
      const t = now()
      if (held && (holdMs === 0 || t - held.at > holdMs)) held = undefined
      const prev = held
      const fallback = prev?.tier ?? options.fallback ?? 'complex'

      let answers: JevAnswers
      try {
        const res = await doFetch(JEV_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildRequest(prompt, { skills: options.skills })),
          signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
        })
        if (!res.ok) return result(fallback, false, `Jev HTTP ${res.status}`, {}, prev?.model)
        answers = ((await res.json()) as { answers?: JevAnswers }).answers ?? {}
      } catch (err) {
        return result(fallback, false, `Jev unavailable: ${err instanceof Error ? err.message : 'request failed'}`, {}, prev?.model)
      }

      const d = decide(answers, { held: prev?.tier, focus })
      if (!d.tier) return result(fallback, false, 'Jev returned no tier', {}, prev?.model)
      const r = result(d.tier, true, d.why, d, d.tier === prev?.tier ? prev.model : undefined)
      if (holdMs > 0) held = { tier: d.tier, at: t, model: r.specialist ? r.model : undefined }
      return r
    },
    /** Change the quality/cost trade-off for later prompts. */
    setFocus(next: Focus) {
      focus = next
      if (held) held.model = undefined
    },
    /** Forget the held tier, e.g. when the user starts a new task. */
    reset() {
      held = undefined
    },
  }
}
