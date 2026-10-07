import { atom, read, update } from 'claude-code'
import type { CommandInfo, EngineInterface, Register } from 'claude-code'
import {
  buildRequest,
  choose,
  CLAUDE_SPECIALISTS,
  DEFAULT_FOCUS,
  decide,
  FOCUS_LABELS,
  isFocus,
  JEV_URL,
  rank,
  TIER_EFFORT,
  TIERS,
  type Effort,
  type Focus,
  type JevAnswers,
  type ModelPlan,
  type Subject,
  type Tier,
} from '../lib/jev-router'
import type { JevUi, LastRoute, Settings } from '../types'

// Before each prompt, one Jev request judges how hard the task is, what it is about,
// what kind of output it wants, and which installed skill (if any) fits. Code then
// picks the model (a subject specialist such as Fable for hard science, otherwise the
// tier's model) and, with effort routing on, the reasoning effort, and applies them to
// every main-loop request of the turn. A control bar above the prompt sets the
// quality/cost focus, turns features on and off, and nudges the model up or down.
// The rubric, thresholds and decisions live in lib/jev-router.ts, shared with agents
// that use the router outside Claude Code.

type Mode = 'auto' | 'off' | Tier

type Decision = {
  at: number
  prompt: string
  tier: Tier
  model: string
  effort?: string
  subject?: string
  why: string
  skill?: string
}

type Active = { tier: Tier; model: string; effort: string | null; at: number; specialist: boolean; subject?: Subject }

// Within an active stretch the tier only goes up: follow-ups like "yes, do it" stay
// on the model that planned the work, and the prompt cache stays warm.
const IDLE_RESET_MS = 10 * 60_000
const JEV_TIMEOUT_MS = 3_000
const CATALOG_TTL_MS = 5 * 60_000
const HISTORY = 20

// A person's prompt, a host's, or a routine's scheduled prompt is routed;
// notifications, peers and the loop's own continuations ride the tier already chosen.
const ROUTED = new Set(['composer', 'bridge', 'sdk', 'unclassified', 'slack-ping', 'plugin', 'scheduled-trigger'])

const FOCUS_NAMES: Record<string, Focus> = { 'token-efficient': 0, efficient: 0, lean: 1, balanced: 2, thorough: 3, 'task-focused': 4, task: 4 }

const LABELS: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
}
const label = (model: string | undefined) => (model ? (LABELS[model] ?? model) : 'the session model')
const isMode = (v: unknown): v is Mode => v === 'auto' || v === 'off' || TIERS.includes(v as Tier)
const parseFocus = (v: string): Focus | undefined => {
  const n = Number(v)
  if (v.trim() !== '' && isFocus(n)) return n
  return FOCUS_NAMES[v.trim().toLowerCase()]
}

const ui = atom({ plugin: 'jev-router', key: 'ui' } as const, {
  mode: 'auto',
  focus: DEFAULT_FOCUS,
  settings: { effort: false, skills: true, specialists: true },
  last: null,
  expanded: false,
  hidden: false,
} as JevUi)

// Session state. The module reloads on a hot reload; session.start restores the
// person's choices from the store.
let mode: Mode = 'auto'
let focus: Focus = DEFAULT_FOCUS
let settings: Settings = { effort: false, skills: true, specialists: true }
let active: Active | undefined
let barHidden = false
let models: Record<Tier, string> = {
  mechanical: 'claude-haiku-4-5-20251001',
  routine: 'claude-sonnet-5-5',
  complex: 'claude-opus-5-5',
  deep: 'claude-opus-5-5',
}
// The skill list, read once per few minutes rather than on every prompt.
let catalog: { at: number; skills: CommandInfo[] } | undefined

const plan = (): ModelPlan => ({
  models,
  efforts: TIER_EFFORT,
  specialists: settings.specialists ? CLAUDE_SPECIALISTS : {},
})

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

/** Pushes the session's choices to the bar and the status line. */
async function show($: EngineInterface, patch: Partial<JevUi> = {}) {
  if (patch.hidden !== undefined) barHidden = patch.hidden
  await update($, ui, s => ({ ...s, ...patch, mode, focus, settings, hidden: barHidden }))
}

function lastRoute(manual = false): LastRoute | null {
  if (!active) return null
  return {
    model: active.model,
    tier: active.tier,
    subject: active.subject,
    effort: settings.effort && active.effort ? active.effort : undefined,
    manual,
  }
}

async function setFocus($: EngineInterface, next: Focus) {
  focus = next
  if (active) active.specialist = false // a held specialist no longer outranks the new focus
  await $.store.set('focus', next)
  await show($)
}

async function setMode($: EngineInterface, next: Mode) {
  mode = next
  active = next === 'auto' || next === 'off' ? undefined : { tier: next, model: models[next], effort: TIER_EFFORT[next], at: await $.clock.now(), specialist: false }
  await $.store.set('mode', next)
  await $.ui.status(next === 'off' ? undefined : next === 'auto' ? 'Jev: auto' : `Jev → ${label(models[next])} (pinned)`)
  await show($, { last: lastRoute() })
}

async function toggle($: EngineInterface, key: keyof Settings) {
  settings = { ...settings, [key]: !settings[key] }
  await $.store.set('settings', settings)
  await show($, { last: lastRoute() })
}

/** The bar's − / + buttons: move this task's model down or up one tier, right away. */
async function nudge($: EngineInterface, by: -1 | 1) {
  const from = active?.tier ?? 'routine'
  const tier = TIERS[Math.max(0, Math.min(TIERS.length - 1, rank(from) + by))]!
  const c = choose(plan(), tier, { subject: active?.subject, focus })
  active = { tier, model: c.model, effort: c.effort, at: await $.clock.now(), specialist: c.specialist, subject: active?.subject }
  await $.ui.status(`Jev → ${label(active.model)} (you)`)
  await show($, { last: lastRoute(true) })
}

export const register: Register = (on, options) => {
  models = {
    mechanical: 'claude-haiku-4-5-20251001',
    routine: 'claude-sonnet-5-5',
    complex: 'claude-opus-5-5',
    deep: typeof options.deepModel === 'string' ? options.deepModel : 'claude-opus-5-5',
  }
  const defaults: Settings = {
    effort: options.effortRouting === true,
    skills: options.skillHints !== false,
    specialists: true,
  }
  const startFocus: Focus =
    typeof options.focus === 'string' && options.focus in FOCUS_NAMES ? FOCUS_NAMES[options.focus]! : DEFAULT_FOCUS
  // Until session.start restores the person's saved choices, start from the config.
  settings = defaults
  focus = startFocus
  mode = 'auto'
  active = undefined
  barHidden = options.focusBar === false

  on('session.start', async ($, e, next) => {
    const savedMode = await $.store.get('mode')
    const savedFocus = await $.store.get('focus')
    const savedSettings = await $.store.get('settings')
    mode = isMode(savedMode) ? savedMode : 'auto'
    focus = isFocus(savedFocus) ? savedFocus : startFocus
    settings = { ...defaults, ...(savedSettings && typeof savedSettings === 'object' ? (savedSettings as Partial<Settings>) : {}) }
    await show($, { hidden: options.focusBar === false })
    await $.command.register({
      name: 'jev',
      description: 'Jev router: status, auto, off, pin <tier>, reset, focus <0-4>, bar',
      argumentHint: '[auto | off | pin <tier> | reset | focus <0-4|name> | bar | effort|skills|specialists on|off]',
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
    const skillList = settings.skills ? await skills($) : []
    let tier: Tier = mode === 'auto' ? (active?.tier ?? 'routine') : mode
    let why = mode === 'auto' ? '' : 'pinned'
    let subject: Subject | undefined
    let output: ReturnType<typeof decide>['output']
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
      const d = decide(answers, { held: active?.tier, focus })
      if (wantTier && d.tier) {
        tier = d.tier
        why = d.why
        subject = d.subject
        output = d.output
      }
      skill = d.skill
    }

    const c = choose(plan(), tier, { subject, output, focus })
    let model = c.model
    let specialist = c.specialist
    if (specialist) why += `, ${subject} specialist`
    else if (active?.specialist && tier === active.tier) {
      model = active.model
      specialist = true
      why += `, held on ${label(model)}`
    }
    active = { tier, model, effort: c.effort, at: now, specialist, subject: subject ?? active?.subject }
    const effort = settings.effort && c.effort ? c.effort : undefined
    await record($, { at: now, prompt: e.text.slice(0, 80), tier, model, effort, subject, why, skill: skill?.name })
    await $.ui.status(`Jev → ${label(model)}${effort ? ` · ${effort}` : ''}${subject ? ` · ${subject}` : ''}${skill ? ` · /${skill.name}` : ''}`)
    await show($, { last: { ...lastRoute()!, skill: skill?.name } })

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
    // left off; otherwise the routed effort when effort routing is on, else the session's.
    const wanted = active.tier === 'mechanical' ? undefined : settings.effort && active.effort ? (active.effort as Effort) : effort
    if (e.model === active.model && wanted === effort) return yield* next(e)
    return yield* next(wanted ? { ...rest, model: active.model, effort: wanted } : { ...rest, model: active.model })
  })

  // A long turn counts as activity, so the idle reset runs from when work stopped.
  on('turn.complete', async ($, e, next) => {
    if (active) active.at = await $.clock.now()
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, ui)
    if (e.props.hasSurvey || s.hidden) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const f = (isFocus(s.focus) ? s.focus : DEFAULT_FOCUS) as Focus
    const routeText = s.mode === 'off'
      ? 'off'
      : s.last
        ? `${label(s.last.model)}${s.last.effort ? ` · ${s.last.effort}` : ''}${s.last.subject ? ` · ${s.last.subject}` : ''}${s.last.manual ? ' (you)' : ''}`
        : 'waiting for a prompt'

    if (!s.expanded) {
      return (
        <Box>
          <Text dimColor>Jev  {routeText}  ·  {FOCUS_LABELS[f]}  </Text>
          <Button key="expand" label="Adjust" plain dimColor onPress={() => update($, ui, x => ({ ...x, expanded: true }))} />
        </Box>
      )
    }

    const onOff = (isOn: boolean) => (isOn ? 'on' : 'off')
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>Focus  Token efficient </Text>
          {([0, 1, 2, 3, 4] as Focus[]).map(n => (
            <Button key={`focus-${n}`} label={n === f ? '●' : '○'} plain onPress={() => setFocus($, n)} />
          ))}
          <Text dimColor> Task focused  ({FOCUS_LABELS[f]})</Text>
        </Box>
        <Box>
          <Button key="toggle-router" label={`Router ${onOff(s.mode !== 'off')}`} dimColor={s.mode === 'off'} onPress={() => setMode($, mode === 'off' ? 'auto' : 'off')} />
          <Button key="toggle-effort" label={`Effort ${onOff(s.settings.effort)}`} dimColor={!s.settings.effort} onPress={() => toggle($, 'effort')} />
          <Button key="toggle-skills" label={`Skills ${onOff(s.settings.skills)}`} dimColor={!s.settings.skills} onPress={() => toggle($, 'skills')} />
          <Button key="toggle-specialists" label={`Specialists ${onOff(s.settings.specialists)}`} dimColor={!s.settings.specialists} onPress={() => toggle($, 'specialists')} />
          <Text dimColor>  Model </Text>
          <Button key="model-down" label="−" plain onPress={() => nudge($, -1)} />
          <Text> {routeText} </Text>
          <Button key="model-up" label="+" plain onPress={() => nudge($, 1)} />
          <Text>  </Text>
          <Button key="collapse" label="Done" plain dimColor onPress={() => update($, ui, x => ({ ...x, expanded: false }))} />
          <Button key="hide" label="Hide" plain dimColor onPress={() => show($, { hidden: true })} />
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'jev' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)

    if (verb === 'auto' || verb === 'off') {
      await setMode($, verb)
      return { text: verb === 'off' ? 'Jev router off: the session model handles every turn.' : 'Jev router on: each prompt picks its own model.' }
    }
    if (verb === 'pin') {
      if (!TIERS.includes(arg as Tier)) return { text: `Pin one of: ${TIERS.join(', ')}.` }
      await setMode($, arg as Tier)
      return { text: `Pinned to ${arg} (${label(models[arg as Tier])}). Skill hints still run. /jev auto to resume routing.` }
    }
    if (verb === 'reset') {
      active = undefined
      await show($, { last: null })
      return { text: 'Cleared the held tier: the next prompt is judged fresh.' }
    }
    if (verb === 'focus') {
      if (arg) {
        const n = parseFocus(arg)
        if (n === undefined) return { text: 'Focus is 0-4 or one of: token-efficient, lean, balanced, thorough, task-focused.' }
        await setFocus($, n)
      }
      await show($, { hidden: false, expanded: true })
      return { text: `Focus: ${FOCUS_LABELS[focus]} (${focus}). The bar above the prompt has the slider.` }
    }
    if (verb === 'bar') {
      await show($, { hidden: !barHidden, expanded: barHidden })
      return { text: barHidden ? 'Control bar hidden. /jev bar shows it again.' : 'Control bar shown.' }
    }
    if (verb === 'effort' || verb === 'skills' || verb === 'specialists') {
      if (arg !== 'on' && arg !== 'off') return { text: `Use /jev ${verb} on or /jev ${verb} off.` }
      if (settings[verb] !== (arg === 'on')) await toggle($, verb)
      return { text: `${verb[0]!.toUpperCase()}${verb.slice(1)}: ${arg}.` }
    }

    const key = await apiKey($)
    const history = await readHistory($)
    const onOff = (b: boolean) => (b ? 'on' : 'off')
    const lines = [
      `Jev router: ${mode === 'auto' || mode === 'off' ? mode : `pinned to ${mode}`}  ·  focus ${FOCUS_LABELS[focus]} (${focus})`,
      `Tiers: ${TIERS.map(t => `${t} → ${label(models[t])}`).join(', ')}`,
      `Specialists: ${onOff(settings.specialists)}${settings.specialists ? ' (hard science and math → Fable 5.1 at balanced focus and above)' : ''}`,
      `Effort routing: ${onOff(settings.effort)}  ·  Skill hints: ${settings.skills ? `on (${catalog?.skills.length ?? '?'} skills)` : 'off'}`,
      key
        ? `API key: found (${key.from})`
        : 'API key: missing. Get one at console.typesafe.ai, then save it to ~/.config/jev/api_key (or set TYPESAFE_API_KEY).',
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
    lines.push('', 'Commands: /jev auto | off | pin <tier> | reset | focus <0-4> | bar | effort|skills|specialists on|off')
    return { text: lines.join('\n') }
  })
}
