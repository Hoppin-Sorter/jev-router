import type { CommandInfo, EngineInterface, Register } from 'claude-code'
import {
  buildRequest,
  decide,
  JEV_URL,
  TIER_EFFORT,
  TIERS,
  type Effort,
  type JevAnswers,
  type Tier,
} from '../lib/jev-router'

// Before each prompt, one Jev request decides two things: which Claude model the
// task needs (by complexity and risk) and which installed skill, if any, fits it.
// The model (and, with effort routing on, the reasoning effort) is applied to every
// main-loop request of the turn; the skill reaches Claude as a hidden note beside
// the prompt. The rubric, thresholds and decision live in lib/jev-router.ts, shared
// with agents that use the router outside Claude Code.

type Mode = 'auto' | 'off' | Tier

type Decision = {
  at: number
  prompt: string
  tier: Tier
  model: string
  effort?: Effort
  why: string
  skill?: string
}

// Within an active stretch the tier only goes up: follow-ups like "yes, do it" stay
// on the model that planned the work, and the prompt cache stays warm.
const IDLE_RESET_MS = 10 * 60_000
const JEV_TIMEOUT_MS = 3_000
const CATALOG_TTL_MS = 5 * 60_000
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
const isMode = (v: unknown): v is Mode => v === 'auto' || v === 'off' || TIERS.includes(v as Tier)

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
  catalog = { at: now, skills: list }
  return catalog.skills
}

async function askJev(
  $: EngineInterface,
  key: string,
  prompt: string,
  wantTier: boolean,
  skillList: CommandInfo[],
): Promise<JevAnswers | { error: string }> {
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
        body: JSON.stringify(buildRequest(prompt, { tier: wantTier, skills: skillList })),
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
  const effortRouting = options.effortRouting === true
  const effortFor = (tier: Tier) => (effortRouting ? (TIER_EFFORT[tier] ?? undefined) : undefined)

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
      const d = decide(answers, active?.tier)
      if (wantTier && d.tier) {
        tier = d.tier
        why = d.why
      }
      skill = d.skill
    }

    active = { tier, model: models[tier], at: now }
    const effort = effortFor(tier)
    await record($, { at: now, prompt: e.text.slice(0, 80), tier, model: active.model, effort, why, skill: skill?.name })
    await $.ui.status(`Jev → ${label(active.model)}${effort ? ` · ${effort}` : ''}${skill ? ` · /${skill.name}` : ''}`)

    if (!skill) return next(e)
    const hint =
      `[jev-router] Jev judged the "${skill.name}" skill relevant to this request (p=${skill.p.toFixed(2)}). ` +
      'If it fits, invoke it with the Skill tool before starting; otherwise ignore this note.'
    return next({ ...e, context: [...(e.context ?? []), hint] })
  })

  // Every main-loop request of the turn goes to the chosen model; subagents keep
  // the model their own definition gives them.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId || mode === 'off' || !active) return yield* next(e)
    const { effort, ...rest } = e
    // Haiku takes no effort setting, so the session's (resolved for its own model) is
    // left off; otherwise the tier's effort when routing it, else the session's.
    const wanted = active.tier === 'mechanical' ? undefined : (effortFor(active.tier) ?? effort)
    if (e.model === active.model && wanted === effort) return yield* next(e)
    return yield* next(wanted ? { ...rest, model: active.model, effort: wanted } : { ...rest, model: active.model })
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
      `Tiers: ${TIERS.map(t => `${t} → ${label(models[t])}${effortFor(t) ? ` (${effortFor(t)})` : ''}`).join(', ')}`,
      `Effort routing: ${effortRouting ? 'on' : "off (your session's effort is kept)"}`,
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
        const effort = d.effort ? ` ${d.effort}` : ''
        lines.push(`  ${time}  ${(label(d.model) + effort).padEnd(16)} ${d.skill ? `/${d.skill}  ` : ''}"${d.prompt}"  ${d.why}`)
      }
    }
    lines.push('', 'Commands: /jev auto | /jev off | /jev pin <tier> | /jev reset')
    return { text: lines.join('\n') }
  })
}
