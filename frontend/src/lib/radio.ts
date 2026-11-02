/** Which parts of a radio group can be chosen: the indexes of the options that are not disabled. */
export function enabledIndexes(options: readonly { disabled?: boolean }[]): number[] {
  return options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0)
}

/**
 * The Tab stop of the group: the chosen part; with none chosen, or a disabled one chosen, the first
 * part that works. -1 when no part works.
 */
export function tabStop(options: readonly { disabled?: boolean }[], checked: number): number {
  return checked >= 0 && !options[checked]?.disabled ? checked : (enabledIndexes(options)[0] ?? -1)
}

/** True for a key press without Alt, Cmd or Ctrl; with one of them the browser or system has its own use (Cmd+← is "back"). */
export function isPlainKey(e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  return !e.altKey && !e.metaKey && !e.ctrlKey
}

/**
 * The part an arrow key, Home or End moves to, starting at index `at` of `enabled`; disabled parts are
 * skipped because `enabled` does not hold them. `undefined` for any other key or when nothing works.
 */
export function stepIndex(enabled: readonly number[], at: number, key: string): number | undefined {
  if (enabled.length === 0) return undefined
  const from = Math.max(at, 0)
  if (key === "ArrowRight" || key === "ArrowDown") return enabled[(from + 1) % enabled.length]
  if (key === "ArrowLeft" || key === "ArrowUp") return enabled[(from - 1 + enabled.length) % enabled.length]
  if (key === "Home") return enabled[0]
  if (key === "End") return enabled[enabled.length - 1]
  return undefined
}
