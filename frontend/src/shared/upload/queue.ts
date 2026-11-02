import { ApiError } from "@/lib/http"
import type { UploadAnswer } from "@/shared/import/types"

/** Sends one file; `onBytes` gets the bytes sent so far of this attempt. */
export type SendFn = (file: File, onBytes: (n: number) => void, signal: AbortSignal) => Promise<UploadAnswer>

export type QueueProgress = { sentBytes: number; totalBytes: number; done: number; total: number }

export type Outcome = {
  file: string
  kind: "stored" | "duplicate" | "error" | "cancelled"
  /** The stored name from the answer, for `stored` and `duplicate`. */
  name?: string
  reason?: string
}

export type QueueOptions = {
  concurrency: number
  /** Attempts per file while the server answers 503. */
  retries: number
  retryMs: number
  onProgress: (p: QueueProgress) => void
}

export function sortFiles(files: File[]): File[] {
  return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done)
  })
}

/**
 * Sends the files sorted by name, `concurrency` at a time. The outcomes come in the same order as
 * `sortFiles(files)`. `cancel()` aborts what is running and drops what has not started; what the
 * server already stored stays stored.
 */
export function runQueue(
  files: File[],
  send: SendFn,
  opts: QueueOptions,
): { done: Promise<Outcome[]>; cancel(): void } {
  const sorted = sortFiles(files)
  const ctrl = new AbortController()
  const outcomes: Outcome[] = sorted.map((f) => ({ file: f.name, kind: "cancelled" }))
  const loaded = sorted.map(() => 0)
  const totalBytes = sorted.reduce((sum, f) => sum + f.size, 0)
  let finished = 0
  let next = 0

  const report = () =>
    opts.onProgress({
      sentBytes: loaded.reduce((a, b) => a + b, 0),
      totalBytes,
      done: finished,
      total: sorted.length,
    })

  async function sendOne(i: number, file: File): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const answer = await send(
          file,
          (n) => {
            loaded[i] = n
            report()
          },
          ctrl.signal,
        )
        outcomes[i] = { file: file.name, kind: answer.status, name: answer.name }
        break
      } catch (error) {
        if (ctrl.signal.aborted) {
          loaded[i] = 0
          report()
          return
        }
        if (error instanceof ApiError && error.status === 503 && attempt < opts.retries) {
          // The next attempt starts from zero bytes: show it now, not with its first progress event.
          loaded[i] = 0
          report()
          await wait(opts.retryMs, ctrl.signal)
          if (ctrl.signal.aborted) return
          continue
        }
        outcomes[i] = {
          file: file.name,
          kind: "error",
          reason: error instanceof Error ? error.message : String(error),
        }
        break
      }
    }
    // A failed file counts as handled, so the bar ends at the full size.
    loaded[i] = file.size
    finished++
    report()
  }

  async function worker(): Promise<void> {
    for (let file = sorted[next]; file && !ctrl.signal.aborted; file = sorted[next]) await sendOne(next++, file)
  }

  const workers = Array.from({ length: Math.min(opts.concurrency, sorted.length) }, worker)
  return {
    done: Promise.all(workers).then(() => outcomes),
    cancel: () => ctrl.abort(),
  }
}
