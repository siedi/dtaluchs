import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
  buildReport: vi.fn(),
  startImport: vi.fn(),
  putFile: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("./xhr", () => ({ putFile: (...args: unknown[]) => mocks.putFile(...args) }))
vi.mock("@/shared/import/api", () => ({ startImport: mocks.startImport, fetchImportStatus: vi.fn(), fetchImportFiles: vi.fn() }))
vi.mock("./report", async (original) => ({ ...(await original<typeof import("./report")>()), buildReport: mocks.buildReport }))

const putFile = mocks.putFile
const { uploadActions, uploadState } = await import("./store")

describe("start", () => {
  beforeEach(() => {
    putFile.mockResolvedValue({ status: "stored", name: "a.dta" })
    mocks.toast.mockClear()
    mocks.toast.error.mockClear()
  })
  afterEach(() => vi.clearAllMocks())

  it("ends in a toast and a report with the notice, not in a store that is wiped; the next upload is not told it is busy", async () => {
    mocks.startImport.mockRejectedValue(new Error("weg"))
    mocks.buildReport.mockImplementationOnce(() => {
      throw new Error("Bericht kaputt")
    })
    await uploadActions.start([new File(["x"], "a.dta")])
    const state = uploadState()
    expect(state.phase).toBe("done")
    expect(state.total).toBe(1)
    expect(state.report?.notice).toContain("Bericht kaputt")
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining("Bericht kaputt"))
    uploadActions.close()
    expect(uploadState().phase).toBe("idle")
  })

  it("forgets the failed files of the upload before, so \"send again\" does not send them", async () => {
    putFile.mockRejectedValueOnce(new Error("kaputt"))
    mocks.buildReport.mockImplementation(() => ({ counts: {}, rows: [], cancelled: 0, pending: 0, notice: null, records: 0 }))
    await uploadActions.start([new File(["x"], "alt.dta")])
    expect(uploadState().failed).toBe(1)
    // A file whose name cannot be read: the upload throws at its start, before it has a result of its own.
    const broken = { get name(): string { throw new Error("Name nicht lesbar") }, size: 1 } as File
    await uploadActions.start([broken])
    putFile.mockClear()
    uploadActions.resendFailed()
    expect(putFile).not.toHaveBeenCalled()
  })
})
