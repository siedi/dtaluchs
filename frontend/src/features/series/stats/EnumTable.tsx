import { useTranslation } from "react-i18next"
import { slotVar } from "@/shared/chart/theme"
import { formatState } from "../format"
import { formatShare } from "./format"
import { splitShares, type Row } from "./groups"
import { StatRow, StatTable } from "./parts"
import type { EnumFigures } from "./types"

// The codes get their own width (five codes and the rest), so bars and texts line up between the rows.
const COLUMNS = "156px 540px"

/** The colour of a code: the palette of the charts, text always next to it. */
const colorOf = (code: number) => `var(${slotVar(code)})`
const REST_COLOR = "color-mix(in oklab, var(--muted-foreground) 55%, transparent)"

/** The states of a group: a narrow bar of the shares and the codes with their shares as text. */
export function EnumTable({ rows }: { rows: Row<EnumFigures>[] }) {
  const { t } = useTranslation()
  return (
    <StatTable kind={t("fieldStats.kind.enum")} labels={[t("fieldStats.col.shares"), t("fieldStats.col.codes")]} columns={COLUMNS} left={[0, 1]}>
      {rows.map(({ field, figures: f }) => {
        const { parts, rest } = splitShares(f.shares)
        const shown = [
          ...parts.map((p) => ({ name: formatState(p.codes, p.text), share: p.share, color: colorOf(p.codes[0] ?? 0) })),
          ...(rest === null ? [] : [{ name: t("fieldStats.rest"), share: rest, color: REST_COLOR }]),
        ]
        return (
          <StatRow key={field.id} field={field} covered={f.covered}>
            <span role="cell" className="pr-3">
              <span
                role="img"
                aria-label={shown.map((p) => `${p.name} ${formatShare(p.share)}`).join(", ")}
                className="flex h-2 w-[140px] items-center"
              >
                {shown.map((p, i) => (
                  <i key={i} className="block h-2 rounded-sm" style={{ flex: `${p.share} 1 0`, minWidth: 2, background: p.color }} />
                ))}
              </span>
            </span>
            <span role="cell" className="flex min-w-0 flex-wrap gap-x-3 text-base">
              {shown.map((p, i) => (
                <span key={i} className="inline-flex max-w-full min-w-0 items-baseline gap-1">
                  <u className="size-2 self-center rounded-sm no-underline" style={{ background: p.color }} />
                  <b className="min-w-0 font-semibold [overflow-wrap:anywhere]">{p.name}</b>
                  <em className="text-muted-foreground not-italic whitespace-nowrap">{formatShare(p.share)}</em>
                </span>
              ))}
            </span>
          </StatRow>
        )
      })}
    </StatTable>
  )
}
