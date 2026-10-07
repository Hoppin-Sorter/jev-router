import type { CommandInfo, EngineInterface, Register } from 'claude-code'

// Before each prompt, one Jev request decides two things: which Claude model the
// task needs (by complexity and risk) and which installed skill, if any, fits it.
// The model is applied to every main-loop request of the turn; the skill reaches
// Claude as a hidden note beside the prompt.

type Tier = 'mechanical' | 'routine' | 'complex' | 'deep'
type Mode = 'auto' | 'off' | Tier

type Decision = {
  at: number
  prompt: string
  tier: Tier
  model: string
  why: string
  skill?: string
}

type ChoiceAnswer = { choice: string; probabilities: Record<string, number> }
type NoulAnswer = { noul: number }
type JevAnswers = { tier?: ChoiceAnswer; risky?: NoulAnswer; skill?: ChoiceAnswer }

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const TIERS: readonly Tier[] = ['mechanical', 'routine', 'complex', 'deep']

const TIER_RUBRIC: Record<Tier, string> = {
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
const ENOUGH: Record<Tier, number> = { mechanical: 0.85, routine: 0.7, complex: 0.5, deep: 0 }
const RISK_FLOOR = 0.7
const SKILL_MIN = 0.5
// Within an active stretch the tier only goes up: follow-ups like "yes, do it" stay
// on the model that planned the work, and the prompt cache stays warm.
const IDLE_RESET_MS = 10 * 60_000
const JEV_TIMEOUT_MS = 3_000
const CATALOG_TTL_MS = 5 * 60_000
const MAX_SKILLS = 254 // a Choice takes 255 options; one is `none`
const DESCRIPTION_CHARS = 200
const PROMPT_CHARS = 6_000
const HISTORY = 20

// A person's prompt (or a host's) is routed; notifications, peers and the loop's
// own continuations ride the tier already chosen.
const ROUTED = new Set(['composer', 'bridge', 'sdk', 'unclassified', 'slack-ping', 'plugin'])

const LABELS: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
}
const label = (model: string | undefined) => (model ? (LABELS[model] ?? model) : 'the session model')
const pct = (p: number | undefined) => `${Math.round((p ?? 0) * 100)}%`
const rank = (tier: Tier) => TIERS.indexOf(tier)
const isMode = (v: unknown): v is Mode => v === 'auto' || v === 'off' || TIERS.includes(v as Tier)

export function pickTier(probabilities: Record<string, number>): Tier {
  let enough = 0
  for (const tier of TIERS) {
    enough += probabilities[tier] ?? 0
    if (enough >= ENOUGH[tier]) return tier
  }
  return 'deep'
}

// The skill list, read once per few minutes rather than on every prompt.
let catalog: { at: number; skills: CommandInfo[] } | undefined

async function apiKey($: EngineInterface): Promise<{ key: string; from: string } | undefined> {
  const typesafe = (await $.env.get('TYPESAFE_API_KEY'))?.trim()
  if (typesafe) return { key: typesafe, from: 'TYPESAFE_API_KEY' }
  const jev = (await $.env.get('JEV_API_KEY'))?.trim()
  if (jev) return { key: jev, from: 'JEV_API_KEY' }
  const home = await $.env.get('HOME')
  if (!home) return undefined
  try {
    const text = (await $.fs.read(`${home}/.config/jev/api_key`)).trim()
    return text ? { key: text, from: '~/.config/jev/api_key' } : undefined
  } catch {
    return undefined
  }
}

async function skills($: EngineInterface): Promise<CommandInfo[]> {
  const now = await $.clock.now()
  if (catalog && now - catalog.at < CATALOG_TTL_MS) return catalog.skills
  const seen = new Set<string>()
  const list = (await $.command.list()).filter(c => {
    if (c.source !== 'plugin' && c.source !== 'user') return false
    if (c.name === 'jev' || !c.description.trim() || seen.has(c.name)) return false
    seen.add(c.name)
    return true
  })
  catalog = { at: now, skills: list.slice(0, MAX_SKILLS) }
  return catalog.skills
}

async function askJev(
  $: EngineInterface,
  key: string,
  prompt: string,
  wantTier: boolean,
  skillList: CommandInfo[],
): Promise<JevAnswers | { error: string }> {
  const questions: Record<string, unknown> = {}
  if (wantTier) {
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
  if (skillList.length) {
    const criteria: Record<string, string> = {
      none: 'No listed skill clearly fits; the agent should just do the work itself.',
    }
    for (const s of skillList) criteria[s.name] = s.description.slice(0, DESCRIPTION_CHARS)
    questions.skill = {
      type: 'choice',
      instructions:
        'Which one skill should a coding agent load to handle `user_message`? Pick `none` unless a skill description clearly matches what the message asks for.',
      criteria,
    }
  }

  const stop = new AbortController()
  const timeout = $.clock.sleep(JEV_TIMEOUT_MS, { signal: stop.signal }).then(
    () => 'timeout' as const,
    () => 'timeout' as const,
  )
  try {
    const res = await Promise.race([
      $.http.fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'jev-latest',
          state: { user_message: prompt.slice(0, PROMPT_CHARS) },
          questions,
        }),
      }),
      timeout,
    ])
    if (res === 'timeout') return { error: 'timed out' }
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return (JSON.parse(res.text) as { answers?: JevAnswers }).answers ?? { error: 'empty answer' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'request failed' }
  } finally {
    stop.abort()
  }
}

async function readHistory($: EngineInterface): Promise<Decision[]> {
  const past = await $.store.get('history')
  return Array.isArray(past) ? (past as Decision[]) : []
}

async function record($: EngineInterface, decision: Decision) {
  const history = await readHistory($)
  await $.store.set('history', [decision, ...history].slice(0, HISTORY))
}

export const register: Register = (on, options) => {
  const models: Record<Tier, string> = {
    mechanical: 'claude-haiku-4-5-20251001',
    routine: 'claude-sonnet-5-5',
    complex: 'claude-opus-5-5',
    deep: typeof options.deepModel === 'string' ? options.deepModel : 'claude-opus-5-5',
  }
  const skillHints = options.skillHints !== false

  let mode: Mode = 'auto'
  let active: { tier: Tier; model: string; at: number } | undefined
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('mode')
    if (isMode(saved)) mode = saved
    await $.command.register({
      name: 'jev',
      description: 'Jev model + skill router: status, auto, off, pin <tier>, reset',
      argumentHint: '[auto | off | pin mechanical|routine|complex|deep | reset]',
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt with no stamped origin is treated as the person's own.
    const origin = e.origin?.kind ?? 'composer'
    if (mode === 'off' || e.turnId || !ROUTED.has(origin) || e.text.trimStart().startsWith('/')) return next(e)

    const now = await $.clock.now()
    if (active && now - active.at > IDLE_RESET_MS) active = undefined

    const wantTier = mode === 'auto'
    const skillList = skillHints ? await skills($) : []
    let tier: Tier = mode === 'auto' ? (active?.tier ?? 'routine') : mode
    let why = mode === 'auto' ? '' : 'pinned'
    let skill: { name: string; p: number } | undefined

    if (wantTier || skillList.length) {
      const key = await apiKey($)
      if (!key) {
        await $.ui.status('Jev: no API key (run /jev)')
        return next(e)
      }
      const answers = await askJev($, key.key, e.text, wantTier, skillList)
      if ('error' in answers) {
        await $.ui.status(`Jev: ${answers.error}; kept ${label(active?.model)}`)
        return next(e)
      }
      if (wantTier && answers.tier) {
        tier = pickTier(answers.tier.probabilities)
        why = `Jev said ${answers.tier.choice} (${pct(answers.tier.probabilities[answers.tier.choice])})`
        if ((answers.risky?.noul ?? 0) >= RISK_FLOOR && rank(tier) < rank('complex')) {
          tier = 'complex'
          why += `, risky (${pct(answers.risky?.noul)})`
        }
        if (active && rank(active.tier) > rank(tier)) {
          why += `, held at ${active.tier}`
          tier = active.tier
        }
      }
      const pick = answers.skill
      const p = pick?.probabilities[pick.choice] ?? 0
      if (pick && pick.choice !== 'none' && p >= SKILL_MIN) skill = { name: pick.choice, p }
    }

    active = { tier, model: models[tier], at: now }
    await record($, { at: now, prompt: e.text.slice(0, 80), tier, model: active.model, why, skill: skill?.name })
    await $.ui.status(`Jev → ${label(active.model)}${skill ? ` · /${skill.name}` : ''}`)

    if (!skill) return next(e)
    const hint =
      `[jev-router] Jev judged the "${skill.name}" skill relevant to this request (p=${skill.p.toFixed(2)}). ` +
      'If it fits, invoke it with the Skill tool before starting; otherwise ignore this note.'
    return next({ ...e, context: [...(e.context ?? []), hint] })
  })

  // Every main-loop request of the turn goes to the chosen model; subagents keep
  // the model their own definition gives them.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId || mode === 'off' || !active || e.model === active.model) return yield* next(e)
    // Haiku takes no effort setting, so the session's (resolved for its own model) is left off.
    if (active.tier === 'mechanical') {
      const { effort: _effort, ...rest } = e
      return yield* next({ ...rest, model: active.model })
    }
    return yield* next({ ...e, model: active.model })
  })

  // A long turn counts as activity, so the idle reset runs from when work stopped.
  on('turn.complete', async ($, e, next) => {
    if (active) active.at = await $.clock.now()
    return next(e)
  })

  on('command.run', { command: 'jev' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const setMode = async (m: Mode) => {
      mode = m
      active = m === 'auto' || m === 'off' ? undefined : { tier: m, model: models[m], at: await $.clock.now() }
      await $.store.set('mode', m)
      await $.ui.status(m === 'off' ? undefined : m === 'auto' ? 'Jev: auto' : `Jev → ${label(models[m])} (pinned)`)
    }

    if (verb === 'auto' || verb === 'off') {
      await setMode(verb)
      return { text: verb === 'off' ? 'Jev router off: the session model handles every turn.' : 'Jev router on: each prompt picks its own model.' }
    }
    if (verb === 'pin') {
      if (!TIERS.includes(arg as Tier)) return { text: `Pin one of: ${TIERS.join(', ')}.` }
      await setMode(arg as Tier)
      return { text: `Pinned to ${arg} (${label(models[arg as Tier])}). Skill hints still run. /jev auto to resume routing.` }
    }
    if (verb === 'reset') {
      active = undefined
      return { text: 'Cleared the held tier: the next prompt is judged fresh.' }
    }

    const key = await apiKey($)
    const history = await readHistory($)
    const lines = [
      `Jev router: ${mode === 'auto' || mode === 'off' ? mode : `pinned to ${mode}`}`,
      `Tiers: ${TIERS.map(t => `${t} → ${label(models[t])}`).join(', ')}`,
      key
        ? `API key: found (${key.from})`
        : 'API key: missing. Get one at console.typesafe.ai, then save it to ~/.config/jev/api_key (or set TYPESAFE_API_KEY).',
      `Skill hints: ${skillHints ? `on (${catalog?.skills.length ?? '?'} skills in the catalog)` : 'off'}`,
      active ? `Current: ${active.tier} → ${label(active.model)} (held until 10 min idle or /jev reset)` : 'Current: none yet',
    ]
    if (history.length) {
      lines.push('', 'Recent decisions:')
      for (const d of history.slice(0, 10)) {
        const time = new Date(d.at).toTimeString().slice(0, 5)
        lines.push(`  ${time}  ${label(d.model).padEnd(10)} ${d.skill ? `/${d.skill}  ` : ''}"${d.prompt}"  ${d.why}`)
      }
    }
    lines.push('', 'Commands: /jev auto | /jev off | /jev pin <tier> | /jev reset')
    return { text: lines.join('\n') }
  })
}
