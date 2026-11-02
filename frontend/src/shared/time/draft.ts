// The Von and Bis fields of the range popover: what a typed text means and when it keeps its time.
import { readInput } from "./format"

/** The text of a field and the time it stands for, or the reason it stands for none. */
export type Field =
  | { text: string; ts: number; error?: undefined }
  | { text: string; ts: null; error: "format" | "range" }
  | { text: string; ts: null; error: "gap"; date: string }

/**
 * Reads a typed text. A text equal to one of `keep` gives that field back with its exact time: the text only
 * shows minutes, and in the hour that occurs twice at the change to winter time it cannot tell the two
 * apart, so reading it again would turn the second one into the first.
 */
export function readField(text: string, ...keep: Field[]): Field {
  const same = keep.find((f) => f.text === text)
  if (same) return same
  const r = readInput(text)
  if (r.ok) return { text, ts: r.ts }
  return r.reason === "gap" ? { text, ts: null, error: "gap", date: r.date } : { text, ts: null, error: r.reason }
}
