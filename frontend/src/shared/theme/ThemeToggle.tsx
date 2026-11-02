import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Segments } from "@/components/Segments"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme, type ThemeChoice } from "./theme"

const CHOICES: readonly { value: ThemeChoice; icon: LucideIcon }[] = [
  { value: "light", icon: SunIcon },
  { value: "dark", icon: MoonIcon },
  { value: "system", icon: MonitorIcon },
]

/** Three icons side by side; below 640 px one button with a menu. */
export function ThemeToggle() {
  const { t } = useTranslation()
  const { choice, set } = useTheme()
  const Current = CHOICES.find((c) => c.value === choice)?.icon ?? MonitorIcon
  return (
    <>
      <div className="max-sm:hidden">
        <Segments
          label={t("app.theme.label")}
          value={choice}
          onChange={set}
          options={CHOICES.map(({ value, icon: Icon }) => ({ value, icon: <Icon />, name: t(`app.theme.${value}`) }))}
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" className="sm:hidden" aria-label={t("app.theme.choose")} title={t("app.theme.label")}>
            <Current />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          <DropdownMenuRadioGroup value={choice} onValueChange={(v) => set(CHOICES.find((c) => c.value === v)?.value ?? "system")}>
            {CHOICES.map(({ value, icon: Icon }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                <Icon />
                {t(`app.theme.${value}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
