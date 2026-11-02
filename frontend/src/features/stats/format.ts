// Display of the key figures; times are in the zone of the installation.
import type { Period } from "@/shared/stats/types"
import { zoneFormat } from "@/shared/time/zone"

const DAY_FORMAT: Intl.DateTimeFormatOptions = { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }
const MONTH_FORMAT: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" }

export function periodLabel(start: number, period: Period): string {
  const d = new Date(start * 1000)
  if (period === "month") return zoneFormat("statsMonth", MONTH_FORMAT).format(d)
  const day = zoneFormat("statsDay", DAY_FORMAT).format(d)
  return period === "week" ? `Woche ab ${day}` : day
}
