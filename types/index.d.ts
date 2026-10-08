// The feature switches the hooks module keeps per session and shares with the widget
// through ~/.config/jev/settings.json.

export type Settings = {
  /** Set reasoning effort along with the model. */
  effort: boolean
  /** Tell Claude which installed skill Jev picked. */
  skills: boolean
  /** Let subject specialists (Fable for hard science and math) replace the tier's model. */
  specialists: boolean
}
