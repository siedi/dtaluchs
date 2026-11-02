import i18n from "@/lib/i18n"
import type { FieldInfo } from "./types"

type Grouped = Pick<FieldInfo, "group" | "group_label" | "known">

/**
 * Key of a field's group. Raw fields of a category form their own group next to the catalog group of the
 * same name, and two groups with the same text stay apart.
 */
export function groupKey(field: Grouped): string {
  return `${field.known ? "known" : "raw"}:${field.group}`
}

/**
 * Heading of a group as the field picker and the statistics show it: the text of
 * the catalog with the name from the file in brackets, "Kältekreis (ChD_Kae_Kreis)", the name alone when the
 * text is the name, and "Ohne Katalogeintrag (…)" for raw fields.
 */
export function groupHeading(field: Grouped): string {
  if (!field.known) return i18n.t("series.unknownGroup", { group: field.group })
  return field.group_label.de === field.group
    ? field.group
    : i18n.t("series.groupWithName", { text: field.group_label.de, group: field.group })
}
