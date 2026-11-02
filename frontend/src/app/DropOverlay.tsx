import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import i18n from "@/lib/i18n"
import { useCapabilities } from "@/shared/config/queries"
import { filesFromDrop } from "@/shared/upload/collect"
import { uploadActions } from "@/shared/upload/store"
import { dropListeners, type DragDepth } from "./drop"

/**
 * A layer over the whole page while files are dragged over it: dropping anywhere uploads, so the browser
 * never opens a dropped file and leaves the page. A drop on another page moves to the import page first.
 * Without the capability `upload` there is no layer and a drop does nothing (`dropListeners`).
 */
export function DropOverlay() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { start } = uploadActions
  const { upload } = useCapabilities()
  const [active, setActive] = useState(false)
  // Outlives a new set of listeners in the middle of a drag (`DragDepth`).
  const depth = useRef<DragDepth>({ depth: 0 })

  useEffect(() => {
    const on = dropListeners(upload, {
      setActive,
      dropped: (dt) => {
        // `filesFromDrop` takes everything from the event before its first `await`.
        const found = filesFromDrop(dt)
        void navigate("/import")
        // `start` reports its own failures; only reading the drop can end here as "folder unreadable".
        void found.then(start, (error: unknown) => {
          toast.error(i18n.t("import.folderUnreadable", { message: error instanceof Error ? error.message : String(error) }))
        })
      },
    }, depth.current)
    window.addEventListener("dragenter", on.dragenter)
    window.addEventListener("dragover", on.dragover)
    window.addEventListener("dragleave", on.dragleave)
    window.addEventListener("drop", on.drop)
    return () => {
      window.removeEventListener("dragenter", on.dragenter)
      window.removeEventListener("dragover", on.dragover)
      window.removeEventListener("dragleave", on.dragleave)
      window.removeEventListener("drop", on.drop)
    }
  }, [navigate, start, upload])

  if (!active || !upload) return null
  return (
    <div aria-hidden className="bg-drop fixed inset-0 z-50 grid place-items-center">
      <div className="border-drop-line pointer-events-none absolute inset-3 rounded-lg border-2 border-dashed" />
      <div className="bg-background pointer-events-none max-w-[calc(100vw-48px)] rounded-lg border px-6 py-4 text-center shadow-pop">
        <b className="block text-md font-semibold">{t("import.upload.overlay")}</b>
        <span className="text-muted-foreground text-base">{t("import.upload.overlayHint")}</span>
      </div>
    </div>
  )
}
