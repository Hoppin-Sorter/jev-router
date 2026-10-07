// The local contract between the jev-router plugin, the menu bar widget and the CLI:
// three files in ~/.config/jev/. Plain JSON, no prompt text, ever.
//
//   settings.json    what the person chose: mode, focus, toggles, and a one-shot
//                    nudge for one session. Whoever writes it bumps updatedAt;
//                    readers apply a settings file newer than the one they last saw.
//   last.json        the latest routing decision, the session it came from, and
//                    whether that session is working right now.
//   decisions.jsonl  one decision per line, newest last, capped at DECISIONS_MAX.
//
// widget/Sources/JevCore/Contract.swift reads and writes the same shapes.

export type RouterMode = 'auto' | 'shadow' | 'off'

export type Nudge = {
  /** The session the nudge is for (its transcript id). */
  target: string
  by: -1 | 1
  /** Unique per press, so a nudge is applied once. */
  id: string
}

export type SharedSettings = {
  version: 1
  mode: RouterMode
  /** 0 = token efficient … 4 = task focused. */
  focus: 0 | 1 | 2 | 3 | 4
  effort: boolean
  skills: boolean
  specialists: boolean
  nudge: Nudge | null
  /** ms since the epoch; the newer file wins. */
  updatedAt: number
  /** Who wrote it: plugin, widget or cli. */
  updatedBy?: string
}

export type DecisionRecord = {
  at: number
  session: string
  tier: string
  model: string
  effort?: string
  subject?: string
  skill?: string
  why: string
  /** Jev's confidence in its tier answer, 0-1. */
  confidence?: number
  /** How long the Jev call took. */
  latencyMs?: number
  /** Estimated input tokens sent to Jev, and what they cost. */
  jevTokens?: number
  jevCostUsd?: number
  /** Decided and logged, but the model was not switched. */
  shadow?: boolean
  /** The person nudged the model by hand. */
  manual?: boolean
  focus?: number
}

export type LastState = {
  version: 1
  session: string
  working: boolean
  /** When the current turn started (working) or the last one ended (idle). */
  since: number
  mode: RouterMode
  decision: DecisionRecord | null
  updatedAt: number
}

export const CONFIG_DIR = '.config/jev'
export const SETTINGS_FILE = 'settings.json'
export const LAST_FILE = 'last.json'
export const DECISIONS_FILE = 'decisions.jsonl'
export const DECISIONS_MAX = 500
/** Jev's list price: $0.042 per million input tokens. */
export const JEV_USD_PER_MTOK = 0.042

export const DEFAULT_SHARED: SharedSettings = {
  version: 1,
  mode: 'auto',
  focus: 2,
  effort: false,
  skills: true,
  specialists: true,
  nudge: null,
  updatedAt: 0,
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Reads settings.json leniently: a bad or missing field takes its default; junk gives undefined. */
export function parseSettings(text: string): SharedSettings | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(raw)) return undefined
  const d = DEFAULT_SHARED
  const mode = raw.mode === 'auto' || raw.mode === 'shadow' || raw.mode === 'off' ? raw.mode : d.mode
  const focus = typeof raw.focus === 'number' && [0, 1, 2, 3, 4].includes(raw.focus) ? (raw.focus as SharedSettings['focus']) : d.focus
  const bool = (k: 'effort' | 'skills' | 'specialists') => (typeof raw[k] === 'boolean' ? (raw[k] as boolean) : d[k])
  const n = raw.nudge
  const nudge: Nudge | null =
    isObject(n) && typeof n.target === 'string' && (n.by === 1 || n.by === -1) && typeof n.id === 'string' && n.id
      ? { target: n.target, by: n.by, id: n.id }
      : null
  return {
    version: 1,
    mode,
    focus,
    effort: bool('effort'),
    skills: bool('skills'),
    specialists: bool('specialists'),
    nudge,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    ...(typeof raw.updatedBy === 'string' ? { updatedBy: raw.updatedBy } : {}),
  }
}

export const formatSettings = (s: SharedSettings) => JSON.stringify(s, null, 2) + '\n'

/** Adds one decision to decisions.jsonl's text and keeps the newest `max` lines. */
export function appendDecision(existing: string, d: DecisionRecord, max = DECISIONS_MAX): string {
  const lines = existing.split('\n').filter(l => l.trim())
  lines.push(JSON.stringify(d))
  return lines.slice(-max).join('\n') + '\n'
}

/** A rough token count for the request sent to Jev (about four characters a token). */
export const estimateTokens = (body: string) => Math.ceil(body.length / 4)
export const jevCost = (tokens: number) => (tokens * JEV_USD_PER_MTOK) / 1_000_000
