import { hasFiles } from "@/shared/upload/collect"

type Drag = Pick<DragEvent, "dataTransfer" | "preventDefault">

interface Hooks {
  /** The layer over the page shows or goes. */
  setActive: (on: boolean) => void
  /** Files were dropped; the transfer must be read before the first `await`. */
  dropped: (dt: DataTransfer) => void
}

/** How deep the drag is in the page; it outlives a new set of listeners (`dropListeners`). */
export interface DragDepth {
  depth: number
}

/**
 * The listeners of the window for files dragged over the page. With `upload` a layer shows and a
 * drop uploads. Without, nothing shows and a drop does nothing; the browser still must not open the file, and the
 * pointer shows no copy. Enter and leave fire for every element on the way; the layer is over only while
 * `state.depth` is above 0. The caller keeps `state`: listeners set anew during a drag (the capabilities arrive, a hook
 * changes) must count on, or the last leave finds 0 and the layer stays.
 */
export function dropListeners(upload: boolean, hooks: Hooks, state: DragDepth) {
  return {
    dragenter: (e: Drag) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (!upload) return
      state.depth++
      hooks.setActive(true)
    },
    dragover: (e: Drag) => {
      if (!hasFiles(e.dataTransfer) || e.dataTransfer === null) return
      // Without this the browser takes the drop for itself and opens the file.
      e.preventDefault()
      if (!upload) e.dataTransfer.dropEffect = "none"
    },
    dragleave: () => {
      if (state.depth === 0) return
      state.depth--
      if (state.depth === 0) hooks.setActive(false)
    },
    drop: (e: Drag) => {
      if (!hasFiles(e.dataTransfer) || e.dataTransfer === null) return
      e.preventDefault()
      // Also without upload: a layer from before the capabilities changed goes with the drop.
      if (state.depth > 0) {
        state.depth = 0
        hooks.setActive(false)
      }
      if (!upload) return
      hooks.dropped(e.dataTransfer)
    },
  }
}
