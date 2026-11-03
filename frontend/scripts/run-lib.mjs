// Runs the cases of a check script: both engines at once, each with PARALLEL cases at once (default 4; PARALLEL=1 runs
// them one after the other). ENGINES=chromium (or webkit) runs one engine. Only for scripts whose cases are independent:
// every case opens its own context or page and writes nothing to the server.
// A full run of abruf.mjs took 324 s one after the other and 50 to 80 s with 4 at once, depending on the load
// (measured).
import { chromium, webkit } from "@playwright/test"

/** The port of a server URL; a URL without one has the port of its scheme. */
export function serverPort(url) {
  const u = new URL(url)
  return Number(u.port || (u.protocol === "https:" ? 443 : 80))
}

/**
 * A console error of a request the page or the browser aborted, no error of the page: WebKit reports a fetch cancelled
 * while a page or context closes as "… due to access control checks." (dauer.mjs, one of five runs, 2026-11-03),
 * Chromium as "AbortError" or "net::ERR_ABORTED".
 */
export const isAbort = (text) => /due to access control checks|AbortError|ERR_ABORTED|cancelled/.test(text)

export const PARALLEL = Math.max(1, Number(process.env.PARALLEL) || 4)
export const ENGINES = [["chromium", chromium], ["webkit", webkit]].filter(([n]) => !process.env.ENGINES || process.env.ENGINES.split(",").includes(n))

/**
 * Runs every job `{name, fn, ...}` in every engine; `fn({browser, engine})` throws on a failed check.
 * `report(job, engine, error)` is called as each job ends (`error` null when it passed). An engine that does not
 * start fails each of its jobs; the other engine runs to its end.
 * `launch` maps an engine name to the options of its `launch()`.
 * Returns the failures `{job, engine, message}` and the number of runs.
 */
export async function runJobs(jobs, { engines = ENGINES, report = () => {}, launch = {} } = {}) {
  const failures = []
  const fail = (job, engine, e) => {
    failures.push({ job, engine, message: e.message })
    report(job, engine, e)
  }
  await Promise.all(engines.map(async ([engine, type]) => {
    let browser
    try {
      browser = await type.launch(launch[engine])
    } catch (e) {
      for (const job of jobs) fail(job, engine, new Error(`${engine} startet nicht: ${e.message.split("\n")[0]}`))
      return
    }
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++]
        try {
          await job.fn({ browser, engine })
          report(job, engine, null)
        } catch (e) {
          fail(job, engine, e)
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker))
    } finally {
      await browser.close()
    }
  }))
  return { failures, count: jobs.length * engines.length }
}
