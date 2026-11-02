import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import type { FieldInfo } from "@/shared/meta/types"

export type FieldLabel = (field: FieldInfo | undefined, id: string) => string

/**
 * Name of a field as the side column, the picker, the details, the table and the lanes on narrow pages show it; the
 * same function while the language stays, so a chart that draws names is not built again on each render.
 */
export function useFieldLabel(): FieldLabel {
  const { t } = useTranslation()
  return useCallback((field, id) => (field ? (field.known ? field.label.de : t("series.rawField", { name: field.label.de })) : id), [t])
}
