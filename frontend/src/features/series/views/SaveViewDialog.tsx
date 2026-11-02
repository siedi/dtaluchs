// "Speichern unter …" and "Umbenennen …".
import { useId, useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ApiError } from "@/lib/http"
import { matchRange, PRESETS, type TimeRange } from "@/shared/time/range"
import type { Layout } from "../types"
import { viewOfLayout } from "../view"
import { useCreateView, useUpdateView } from "./queries"
import type { View } from "./types"
import { savedRange } from "./views"

export const MAX_NAME = 60 // a name has 1 to 60 characters

interface Props {
  mode: "saveAs" | "rename"
  /** The loaded view; the one to rename. */
  current: View | null
  views: View[]
  layout: Layout
  range: TimeRange
  stock: { first_ts: number; last_ts: number }
  onClose: () => void
  onSaved: (view: View) => void
}

export function SaveViewDialog({ mode, current, views, layout, range, stock, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const rename = mode === "rename"
  const create = useCreateView()
  const update = useUpdateView()
  const pending = create.isPending || update.isPending
  const [name, setName] = useState(rename && current ? current.name : "")
  // The field shows an error only after the first keystroke or a try to save.
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const key = matchRange(range, stock, PRESETS)
  const [relative, setRelative] = useState(key !== null)
  const ids = { name: useId(), error: useId(), radios: useId() }

  const trimmed = name.trim()
  const lower = trimmed.toLowerCase()
  const taken = views.some((v) => v.name.toLowerCase() === lower && !(rename && v.id === current?.id))
  const problem = !trimmed ? t("views.nameEmpty") : taken ? t("views.nameTaken") : null
  const shown = touched ? (problem ?? serverError) : null
  const period = key === null ? null : PRESETS.some((p) => p.key === key) ? t(`range.presets.${key}`) : t(`range.calendar.${key}`)

  const failed = (error: Error, text: "views.saveFailed" | "views.renameFailed") => {
    // A taken name or a refused one belongs to the field, anything else to a toast.
    if (error instanceof ApiError && (error.status === 409 || error.status === 422)) setServerError(error.message)
    else toast.error(t(text, { message: error.message }))
  }

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault()
    setTouched(true)
    if (problem || pending) return
    if (rename && current) {
      update.mutate(
        { id: current.id, body: { name: trimmed } },
        {
          onSuccess: (view) => {
            toast.success(t("views.renamed"))
            onSaved(view)
          },
          onError: (error) => failed(error, "views.renameFailed"),
        },
      )
      return
    }
    create.mutate(viewOfLayout(layout, trimmed, savedRange(range, stock, relative)), {
      onSuccess: (view) => {
        toast.success(t("views.saved", { name: view.name }))
        onSaved(view)
      },
      onError: (error) => failed(error, "views.saveFailed"),
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent showCloseButton={false} className="gap-3 p-4 sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle className="text-md font-semibold">{rename ? t("views.renameTitle") : t("views.saveTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{rename ? t("views.renameTitle") : t("views.saveTitle")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-2" noValidate>
          <label htmlFor={ids.name} className="text-muted-foreground grid gap-1 text-base">
            {t("views.name")}
            <Input
              id={ids.name}
              value={name}
              maxLength={MAX_NAME}
              autoComplete="off"
              aria-invalid={shown ? true : undefined}
              aria-describedby={ids.error}
              onChange={(e) => {
                setName(e.target.value)
                setTouched(true)
                setServerError(null)
              }}
              className="text-foreground h-8"
            />
          </label>
          <p id={ids.error} role="alert" className="text-crit min-h-4 text-xs">
            {shown}
          </p>
          {!rename && (
            <>
              <div role="radiogroup" aria-labelledby={ids.radios} className="flex flex-wrap gap-x-4 gap-y-1 text-base">
                <span id={ids.radios} className="sr-only">{t("range.label")}</span>
                <label className={`flex items-center gap-1 ${key === null ? "text-muted-foreground" : ""}`}>
                  <input type="radio" name="range" className="accent-foreground" checked={relative && key !== null} disabled={key === null} onChange={() => setRelative(true)} />
                  {period ? t("views.relativeAs", { period }) : t("views.relative")}
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" name="range" className="accent-foreground" checked={!relative || key === null} onChange={() => setRelative(false)} />
                  {t("views.fixed")}
                </label>
              </div>
              <p className="text-muted-foreground text-base">{key !== null ? t("views.relativeHint") : t("views.fixedHint")}</p>
            </>
          )}
          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t("views.cancel")}
            </Button>
            <Button type="submit" disabled={pending || shown !== null}>
              {rename ? t("views.doRename") : t("views.doSave")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
