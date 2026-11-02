// The menu "Ansichten" in the range bar: the loaded view with "geändert", the list, save, rename, start view and delete.
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useCapabilities } from "@/shared/config/queries"
import type { TimeRange } from "@/shared/time/range"
import type { Layout } from "../types"
import { viewOfLayout } from "../view"
import { SaveViewDialog } from "./SaveViewDialog"
import { useDeleteView, useUpdateView, useViews } from "./queries"
import type { View } from "./types"
import { savedRange, unsavedChange } from "./views"

interface Props {
  /** The loaded view, null when none or the list is not there. */
  current: View | null
  changed: boolean
  layout: Layout
  range: TimeRange
  stock: { first_ts: number; last_ts: number }
  onLoad: (view: View) => void
  /** A view was saved or renamed; the URL takes its id. */
  onSaved: (view: View) => void
  onDeleted: () => void
}

type Open =
  | { kind: "saveAs" | "rename" | "delete" }
  | { kind: "discard"; view: View }
  | null

export function ViewsMenu({ current, changed, layout, range, stock, onLoad, onSaved, onDeleted }: Props) {
  const { t } = useTranslation()
  // Without the capability the menu only loads views: no writing entries, no empty group "Eigene".
  const { views: canWrite } = useCapabilities()
  const views = useViews()
  const update = useUpdateView()
  const remove = useDeleteView()
  const [open, setOpen] = useState<Open>(null)

  const list = views.data?.views ?? []
  const problem = views.data?.problem ?? null
  const builtin = current?.builtin ?? false
  // Only an unreadable views.json stops writing; a single broken view is named but blocks nothing.
  const locked = views.data?.writable === false
  const close = () => setOpen(null)

  // Without the capability nothing can be saved: no "geändert", no question before loading another view.
  const dirty = unsavedChange(changed, canWrite)
  const load = (view: View) => (dirty ? setOpen({ kind: "discard", view }) : onLoad(view))

  const save = () => {
    if (!current) return
    const { name: _, ...body } = viewOfLayout(layout, current.name, savedRange(range, stock, "preset" in current.range))
    update.mutate(
      { id: current.id, body },
      {
        onSuccess: (view) => toast.success(t("views.saved", { name: view.name })),
        onError: (error) => toast.error(t("views.saveFailed", { message: error.message })),
      },
    )
  }

  const toggleStart = () => {
    if (!current) return
    const start = !current.start
    update.mutate(
      { id: current.id, body: { start } },
      {
        onSuccess: (view) => toast.success(start ? t("views.startOn", { name: view.name }) : t("views.startOff")),
        onError: (error) => toast.error(t("views.startFailed", { message: error.message })),
      },
    )
  }

  const confirmDelete = () => {
    if (!current) return
    const name = current.name
    remove.mutate(current.id, {
      onSuccess: () => {
        toast.success(t("views.deleted", { name }))
        close()
        onDeleted()
      },
      onError: (error) => toast.error(t("views.deleteFailed", { message: error.message })),
    })
  }

  const row = (view: View) => (
    <DropdownMenuItem key={view.id} onSelect={() => load(view)} className="text-base">
      {current?.id === view.id ? <CheckIcon className="size-3" /> : <span className="size-3" />}
      <span className="min-w-0 break-words">{view.name}</span>
      {view.start && <span className="text-muted-foreground ml-auto pl-4 text-xs whitespace-nowrap">{t("views.atStart")}</span>}
    </DropdownMenuItem>
  )
  const own = list.filter((v) => !v.builtin)
  const busy = update.isPending || remove.isPending

  let content
  if (views.isError) {
    content = (
      <div className="grid gap-2 p-1">
        <p className="text-crit text-base">{t("views.loadFailed", { message: views.error.message })}</p>
        <div className="flex justify-end">
          <Button variant="outline" disabled={views.isFetching} onClick={() => void views.refetch()}>
            {views.isFetching ? t("views.loading") : t("views.retry")}
          </Button>
        </div>
      </div>
    )
  } else if (views.isPending) {
    content = <DropdownMenuItem disabled className="text-base">{t("views.loading")}</DropdownMenuItem>
  } else {
    content = (
      <>
        <DropdownMenuLabel className="text-xs font-medium">{t("views.builtin")}</DropdownMenuLabel>
        {list.filter((v) => v.builtin).map(row)}
        {(canWrite || own.length > 0) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium">{t("views.own")}</DropdownMenuLabel>
            {own.map(row)}
          </>
        )}
        {canWrite && own.length === 0 && !locked && <DropdownMenuItem disabled className="text-base">{t("views.noOwn")}</DropdownMenuItem>}
        {problem !== null && (
          <DropdownMenuItem disabled className="max-w-[320px] text-base whitespace-normal">
            {locked && canWrite ? `${problem} ${t("views.locked")}` : problem}
          </DropdownMenuItem>
        )}
        {canWrite && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={locked || !current || builtin || !dirty || busy} onSelect={save} className="text-base">
              {t("views.save")}
              {builtin && <span className="text-muted-foreground ml-auto pl-4 text-xs whitespace-nowrap">{t("views.shipped")}</span>}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={locked} onSelect={() => setOpen({ kind: "saveAs" })} className="text-base">
              {t("views.saveAs")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={locked || !current || builtin} onSelect={() => setOpen({ kind: "rename" })} className="text-base">
              {t("views.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={locked || !current || busy} onSelect={toggleStart} className="text-base">
              {current?.start ? t("views.noStart") : t("views.start")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={locked || !current || builtin}
              onSelect={() => setOpen({ kind: "delete" })}
              className="text-base"
            >
              {t("views.delete")}
            </DropdownMenuItem>
            {builtin && !locked && <p className="text-muted-foreground max-w-[320px] px-2 py-1 text-xs">{t("views.shippedHint")}</p>}
          </>
        )}
      </>
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="max-w-full" title={t("views.menu")}>
            <span className="text-muted-foreground">{t("views.label")}</span>
            <b className="max-w-[180px] truncate font-medium max-sm:max-w-[96px]">{current?.name ?? t("views.standard")}</b>
            {dirty && <span className="text-muted-foreground rounded-full border px-1 text-xs leading-4">{t("views.changed")}</span>}
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[240px]">
          {content}
        </DropdownMenuContent>
      </DropdownMenu>
      {(open?.kind === "saveAs" || open?.kind === "rename") && (
        <SaveViewDialog
          mode={open.kind}
          current={current}
          views={list}
          layout={layout}
          range={range}
          stock={stock}
          onClose={close}
          onSaved={(view) => {
            close()
            onSaved(view)
          }}
        />
      )}
      {open?.kind === "discard" && current && (
        <Confirm
          title={t("views.discardTitle")}
          text={t("views.discardText", { name: current.name })}
          action={t("views.discard")}
          onClose={close}
          onConfirm={() => {
            close()
            onLoad(open.view)
          }}
        />
      )}
      {open?.kind === "delete" && current && (
        <Confirm
          title={t("views.deleteTitle")}
          text={t("views.deleteText", { name: current.name })}
          action={t("views.doDelete")}
          danger
          pending={remove.isPending}
          onClose={close}
          onConfirm={confirmDelete}
        />
      )}
    </>
  )
}

interface ConfirmProps {
  title: string
  text: string
  action: string
  danger?: boolean
  pending?: boolean
  onClose: () => void
  onConfirm: () => void
}

/** A question before a step that loses something: cancel or go on. */
function Confirm({ title, text, action, danger, pending, onClose, onConfirm }: ConfirmProps) {
  const { t } = useTranslation()
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent showCloseButton={false} className="gap-3 p-4 sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle className="text-md font-semibold">{title}</DialogTitle>
          <DialogDescription className="text-base">{text}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-1">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t("views.cancel")}
          </Button>
          <Button variant={danger ? "destructive" : "default"} onClick={onConfirm} disabled={pending}>
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
