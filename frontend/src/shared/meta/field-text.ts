import type { FieldInfo } from "./types"

type Named = Pick<FieldInfo, "label" | "raw_names">

/**
 * A field without its own label shows the raw name of the newest layout as its label in both languages
 *. Comparing `de` alone is not enough: "Außentemperatur" is a catalog label and a raw name.
 */
export function hasOwnLabel(field: Named): boolean {
  const raw = field.raw_names[0]
  return raw === undefined || field.label.de !== raw || field.label.en !== raw
}

/**
 * Second line of the field picker: abbreviation and raw name, "TVL / Vorlauf"; once if both are the same, "HUP"; none
 * without own label.
 */
export function fieldSubline(field: Pick<FieldInfo, "label" | "raw_names" | "abbr">): string {
  if (!hasOwnLabel(field)) return ""
  return [...new Set([field.abbr, field.raw_names[0]].filter(Boolean))].join(" / ")
}

/**
 * Does the query find the field? One search text from label, abbreviation, all raw names and id, in this order. The
 * query is a substring of it, so several words must follow each other directly in that order and may come from
 * different sources ("Heizkreis TVL"). Case does not matter, `query` is trimmed.
 */
export function matchesField(field: Pick<FieldInfo, "id" | "abbr" | "raw_names">, label: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [label, field.abbr, ...field.raw_names, field.id].filter(Boolean).join(" ").toLowerCase().includes(q)
}
