import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { changedByImport, setStatus, statusOptions } from "./options"
import type { ImportStatus } from "./types"

const status = (running: boolean) => ({ running, queued: false, last: null }) as unknown as ImportStatus

describe("changedByImport", () => {
  it("names what an import does not change; every other query, also a new one, reloads", () => {
    for (const key of ["config", "views", "import-status"]) expect(changedByImport({ queryKey: [key, 1] })).toBe(false)
    for (const key of ["meta", "latest", "stats", "series", "field-stats", "field-scope", "events", "import-files", "import-runs", "a-new-one"]) {
      expect(changedByImport({ queryKey: [key, { a: 1 }] })).toBe(true)
    }
  })

  it("invalidates the data and leaves the status and the settings as they are", async () => {
    const client = new QueryClient()
    for (const key of ["meta", "series", "config", "views", "import-status"]) client.setQueryData([key], key)
    await client.invalidateQueries({ predicate: changedByImport })
    const invalidated = ["meta", "series", "config", "views", "import-status"].filter((k) => client.getQueryState([k])?.isInvalidated)
    expect(invalidated).toEqual(["meta", "series"])
  })
})

describe("setStatus", () => {
  it("is not overwritten by a poll that was asked before the run began", async () => {
    const client = new QueryClient()
    let answer: (s: ImportStatus) => void = () => {}
    const poll = client.query({ ...statusOptions, queryFn: () => new Promise<ImportStatus>((resolve) => (answer = resolve)), staleTime: 0 })
    poll.catch(() => {})
    await setStatus(client, status(true))
    answer(status(false))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.getQueryData<ImportStatus>(statusOptions.queryKey)?.running).toBe(true)
  })
})
