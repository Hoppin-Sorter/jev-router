// What the jev-router control bar draws from: the focus level, the feature toggles,
// the last routing decision, and whether the bar is expanded or hidden.

export type Settings = {
  /** Set reasoning effort along with the model. */
  effort: boolean
  /** Tell Claude which installed skill Jev picked. */
  skills: boolean
  /** Let subject specialists (Fable for hard science and math) replace the tier's model. */
  specialists: boolean
}

export type LastRoute = {
  model: string
  tier: string
  subject?: string
  effort?: string
  skill?: string
  /** True when the person nudged the model with the bar's − / + buttons. */
  manual?: boolean
}

export type JevUi = {
  /** 'auto', 'off', or a pinned tier. */
  mode: string
  /** 0 = token efficient … 4 = task focused. */
  focus: number
  settings: Settings
  last: LastRoute | null
  expanded: boolean
  hidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'jev-router': { ui: JevUi }
  }
}
