import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router"
import { Section, Skeleton, TextSkeleton } from "@/components/Section"
import { ROW_CLICKABLE, ROW_LINK, useRowClick } from "@/components/row-link"
import { TABLE_BASE, TABLE_FRAME, TD, TH } from "@/components/table"
import { Button } from "@/components/ui/button"
import { CsvButton } from "@/shared/export/CsvButton"
import type { Meta } from "@/shared/meta/types"
import { formatDuration, formatInput, formatNumber } from "@/shared/time/format"
import { seriesLink } from "@/shared/time/links"
import { StockBand, type BandFirmware } from "./StockBand"
import { metaCsvUrl } from "./api"
import { changeSpan, firmwareName, firmwareRange, formatDay, gapRange, longestGap } from "./overview"
import { readShape, saveShape } from "./shape"
import type { GapInfo } from "./types"

type Stock = NonNullable<Meta["range"]>

const count = (n: number) => formatNumber(n, 0)
const GAP_LINE = "text-muted-foreground mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base"
const bold = { b: <b className="font-semibold" /> }

/** Stock: one band with firmware sections and gaps, the gap sum and the table of firmware. */
export function StockSection({ meta, stock }: { meta: Meta; stock: Stock }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [allGaps, setAllGaps] = useState(false)
  const { firmware, gaps } = meta

  const firmwareTo = (i: number) => seriesLink(firmwareRange(firmware[i]!, stock))
  const gapTo = (gap: GapInfo) => seriesLink(gapRange(gap))
  const go = (to: string) => void navigate(to)
  const rowClick = useRowClick()

  const { layouts } = meta
  // Kept between renders, so the band keeps its layout when the section renders again, e.g. for "Alle Lücken".
  const rows = useMemo(() => firmware.map((f, i) => {
    const layout = layouts.find((l) => l.id === f.layout_id)
    const raw = f.software_version
    const name = raw === null ? t("overview.stock.unknown") : firmwareName(raw)
    const change = changeSpan(firmware, i, gaps)
    const changeText = change && t("overview.stock.change", { from: formatInput(change.from), to: formatInput(change.to) })
    const tip = (
      <>
        <Trans
          i18nKey={raw === null ? "overview.stock.firmwareTipUnknown" : "overview.stock.firmwareTip"}
          values={{ name, raw, layout: f.layout_id }}
          components={bold}
        />
        <br />
        {t("overview.stock.period", { from: formatInput(f.first_ts), to: formatInput(f.last_ts) })}
        {changeText && (
          <>
            <br />
            <span className="text-muted-foreground">{changeText}</span>
          </>
        )}
      </>
    )
    return { f, i, raw, name, layout, changeText, tip }
  }), [firmware, gaps, layouts, t])
  const bandFirmware = useMemo<BandFirmware[]>(
    () => rows.map((r) => ({ name: r.name, first_ts: r.f.first_ts, last_ts: r.f.last_ts, tip: r.tip })),
    [rows],
  )
  const newestFirst = [...rows].reverse()
  const gapsLongestFirst = [...gaps].sort((a, b) => b.seconds - a.seconds)
  const longest = longestGap(gaps)
  const info = meta.import
  const hasGaps = longest !== null
  useEffect(() => saveShape({ firmware: firmware.length, gaps: hasGaps }), [firmware.length, hasGaps])

  const gapTip = (gap: GapInfo) => (
    <>
      <Trans i18nKey="overview.stock.gapTip" values={{ duration: formatDuration(gap.seconds) }} components={bold} />
      <br />
      {t("overview.stock.period", { from: formatInput(gap.start_ts), to: formatInput(gap.end_ts) })}
    </>
  )

  return (
    <Section
      id="h-stock"
      title={t("overview.stock.title")}
      // This section only exists with a stock, so the button is never locked here.
      action={
        <CsvButton
          items={[
            { label: t("csv.layouts"), href: metaCsvUrl("layouts") },
            { label: t("csv.gaps"), href: metaCsvUrl("gaps") },
          ]}
        />
      }
      sub={t("overview.stock.sub", {
        from: formatDay(stock.first_ts), to: formatDay(stock.last_ts), records: count(info.records), fields: count(meta.fields.length),
      })}
    >
      <StockBand
        firmware={bandFirmware}
        gaps={gaps}
        range={stock}
        gapTip={gapTip}
        onFirmware={(i) => go(firmwareTo(i))}
        onGap={(i) => go(gapTo(gaps[i]!))}
      />

      <div className={GAP_LINE}>
        {longest ? (
          <>
            <span>
              <Trans
                i18nKey="overview.stock.gapsSum"
                count={info.gaps}
                values={{
                  total: formatDuration(info.gap_s),
                  longest: formatDuration(longest.seconds),
                  from: formatDay(longest.start_ts),
                  to: formatDay(longest.end_ts),
                }}
                components={{ b: <b className="text-foreground font-medium" /> }}
              />
            </span>
            <Button variant="link" aria-expanded={allGaps} aria-controls="gap-list" onClick={() => setAllGaps((v) => !v)}>
              {t(allGaps ? "overview.stock.hideGaps" : "overview.stock.allGaps")}
            </Button>
          </>
        ) : (
          <span>{t("overview.stock.noGaps")}</span>
        )}
      </div>

      {longest && allGaps && (
        <div id="gap-list" className={`${TABLE_FRAME} mt-2 max-h-80 overflow-y-auto`}>
          <table className={`w-full ${TABLE_BASE}`}>
            <thead>
              <tr>
                <Th>{t("overview.stock.gapStart")}</Th>
                <Th>{t("overview.stock.gapEnd")}</Th>
                <Th right>{t("overview.stock.gapDuration")}</Th>
              </tr>
            </thead>
            <tbody>
              {gapsLongestFirst.map((g) => (
                <tr
                  key={g.start_ts}
                  className={`${ROW_CLICKABLE} hover:bg-accent focus-within:bg-accent`}
                  onClick={rowClick(gapTo(g))}
                >
                  <Td>
                    <Link to={gapTo(g)} className={ROW_LINK}>{formatInput(g.start_ts)}</Link>
                  </Td>
                  <Td>{formatInput(g.end_ts)}</Td>
                  <Td right>{formatDuration(g.seconds)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <FirmwareTables
        rows={newestFirst.map((r) => {
          const raw = r.raw === null ? null : t("overview.stock.rawVersion", { raw: r.raw })
          const from = formatInput(r.f.first_ts)
          const to = formatInput(r.f.last_ts)
          const records = count(r.f.records)
          const files = r.layout ? count(r.layout.files) : "–"
          const fields = r.layout ? count(r.layout.fields) : "–"
          return {
            key: r.i,
            name: r.name,
            raw,
            layout: String(r.f.layout_id),
            from,
            change: r.changeText,
            to,
            records,
            files,
            fields,
            item: [raw, t("overview.stock.itemLayout", { layout: r.f.layout_id })].filter(Boolean).join(", "),
            period: t("overview.stock.period", { from, to }),
            counts: t("overview.stock.itemCounts", { records, files, fields }),
            href: firmwareTo(r.i),
          }
        })}
      />
    </Section>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`${TH} ${right ? "text-right" : "text-left"}`}>{children}</th>
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td className={`${TD} ${right ? "text-right" : ""}`}>{children}</td>
}

/** One row of the firmware table and of its list below 640 px: the texts, or their placeholders while the stock loads. */
interface FirmwareRow {
  key: number
  name: ReactNode
  /** "SW_Stand 3923", null for an unknown firmware. */
  raw: ReactNode
  layout: ReactNode
  from: ReactNode
  /** When the firmware changed, null where nothing is known. */
  change: ReactNode
  to: ReactNode
  records: ReactNode
  files: ReactNode
  fields: ReactNode
  /** The list: version and layout, period, counts. */
  item: ReactNode
  period: ReactNode
  counts: ReactNode
  /** Address of the firmware in the series; a placeholder row has none. */
  href?: string
}

const HEADS = ["colFirmware", "colLayout", "colFrom", "colTo", "colRecords", "colFiles", "colFields"] as const

/** The table of firmware, below 640 px a list; one markup for the loaded rows and their placeholders. */
function FirmwareTables({ rows, placeholder = false }: { rows: FirmwareRow[]; placeholder?: boolean }) {
  const { t } = useTranslation()
  const rowClick = useRowClick()
  if (rows.length === 0) return null
  const head = (key: (typeof HEADS)[number]) => (placeholder ? <TextSkeleton>{t(`overview.stock.${key}`)}</TextSkeleton> : t(`overview.stock.${key}`))
  const act = (r: FirmwareRow) =>
    r.href ? { className: `${ROW_CLICKABLE} hover:bg-accent focus-within:bg-accent`, onClick: rowClick(r.href) } : {}
  // The name is the link of the row (a placeholder row has none).
  const name = (r: FirmwareRow) => (r.href ? <Link to={r.href} className={ROW_LINK}>{r.name}</Link> : r.name)
  return (
    <>
      <div className={`${TABLE_FRAME} mt-4 max-sm:hidden`}>
        <table className={`w-full ${TABLE_BASE}`}>
          <thead>
            <tr>
              {HEADS.map((key, i) => <Th key={key} right={i >= 4}>{head(key)}</Th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} {...act(r)}>
                <Td>
                  <span className="font-semibold">{name(r)}</span>
                  {r.raw !== null && <small className="text-muted-foreground block text-xs">{r.raw}</small>}
                </Td>
                <Td>{r.layout}</Td>
                <Td>
                  {r.from}
                  {r.change !== null && <small className="text-muted-foreground block text-xs">{r.change}</small>}
                </Td>
                <Td>{r.to}</Td>
                <Td right>{r.records}</Td>
                <Td right>{r.files}</Td>
                <Td right>{r.fields}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="m-0 mt-4 hidden list-none p-0 text-base max-sm:block">
        {rows.map((r) => {
          const a = act(r)
          return (
            <li key={r.key} {...a} className={`border-b py-2 ${a.className ?? ""}`}>
              <b>{name(r)}</b> <span className="text-muted-foreground">{r.item}</span>
              <br />
              {r.period}
              {r.change !== null && <small className="text-muted-foreground block text-xs">{r.change}</small>}
              <span className="text-muted-foreground block">{r.counts}</span>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/**
 * The stock as it loads: band, gap line (the one without gaps where the last visit had none) and as many firmware rows
 * as at the last visit (one before the first), each
 * with the texts of a typical row, so the table takes the widths and breaks of the loaded one.
 */
export function StockSkeleton() {
  const { t } = useTranslation()
  const shape = readShape()
  const n = shape.firmware
  // Every time and day has the same length; the time of 0 is as good as any.
  const time = formatInput(0)
  const sample = (key: number): FirmwareRow => ({
    key,
    name: <TextSkeleton>V3.92.3</TextSkeleton>,
    raw: <TextSkeleton>{t("overview.stock.rawVersion", { raw: 3923 })}</TextSkeleton>,
    layout: <TextSkeleton>7</TextSkeleton>,
    from: <TextSkeleton>{time}</TextSkeleton>,
    // The oldest firmware has no change before it.
    change: key === n - 1 ? null : <TextSkeleton>{t("overview.stock.change", { from: time, to: time })}</TextSkeleton>,
    to: <TextSkeleton>{time}</TextSkeleton>,
    records: <TextSkeleton>{count(248640)}</TextSkeleton>,
    files: <TextSkeleton>173</TextSkeleton>,
    fields: <TextSkeleton>132</TextSkeleton>,
    item: <TextSkeleton>{`${t("overview.stock.rawVersion", { raw: 3923 })}, ${t("overview.stock.itemLayout", { layout: 7 })}`}</TextSkeleton>,
    period: <TextSkeleton>{t("overview.stock.period", { from: time, to: time })}</TextSkeleton>,
    counts: <TextSkeleton>{t("overview.stock.itemCounts", { records: count(248640), files: 173, fields: 132 })}</TextSkeleton>,
  })
  const day = formatDay(0)
  const gaps = t("overview.stock.gapsSum", { count: 55, total: formatDuration(7672320), longest: formatDuration(4993920), from: day, to: day })
  return (
    <div aria-hidden data-skeleton>
      <Skeleton className="h-16 w-full" />
      <div className={GAP_LINE}>
        {shape.gaps === false ? (
          <span><TextSkeleton>{t("overview.stock.noGaps")}</TextSkeleton></span>
        ) : (
          <>
            <span><TextSkeleton>{gaps.replace(/<\/?b>/g, "")}</TextSkeleton></span>
            <span className="whitespace-nowrap"><TextSkeleton>{t("overview.stock.allGaps")}</TextSkeleton></span>
          </>
        )}
      </div>
      <FirmwareTables rows={Array.from({ length: n }, (_, i) => sample(i))} placeholder />
    </div>
  )
}
