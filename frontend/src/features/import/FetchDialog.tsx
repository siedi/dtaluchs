import { CircleXIcon, XIcon } from "lucide-react"
import { useId, useRef, useState, type SubmitEvent, type ReactNode, type Ref } from "react"
import { useTranslation } from "react-i18next"
import { Fact, Facts } from "@/components/Facts"
import { LineIcon } from "@/components/LineIcon"
import { ReasonPopover } from "@/components/ReasonPopover"
import { Warn } from "@/components/Warn"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ApiError, fieldText } from "@/lib/http"
import { formatAge } from "@/shared/import/age"
import { fetchStale } from "@/shared/import/fetch"
import { fetchLock } from "@/shared/import/lock"
import { useSaveFetchSettings } from "@/shared/import/queries"
import type { ImportStatus } from "@/shared/import/types"
import { formatRunClock, formatRunStamp } from "@/shared/time/format"
import { CODE } from "./parts"

type Fetch = ImportStatus["fetch"]

/** The button of the row and the dialog "Abruf von der Steuerung". */
export function FetchDialog({ status, now }: { status: ImportStatus; now: number }) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("import.fetch.setup")}
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-xl"
        // The address is what the dialog is for; the focus starts there, not on the close button.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          input.current?.focus()
        }}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>{t("import.fetch.dialog.title")}</DialogTitle>
          <DialogDescription>{t("import.fetch.dialog.text")}</DialogDescription>
        </DialogHeader>
        <DialogClose asChild>
          <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" aria-label={t("import.fetch.dialog.close")}>
            <XIcon aria-hidden />
          </Button>
        </DialogClose>
        <FetchForm fetch={status.fetch} now={now} input={input} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("import.fetch.dialog.close")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The message of a refused save, under its control; read out when it appears. */
function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-crit mt-1 flex items-start gap-1">
      <LineIcon>
        <CircleXIcon aria-hidden className="size-4" />
      </LineIcon>
      <span>{children}</span>
    </p>
  )
}

/** The refusal of a save as the API sent it, without the field name `detailText` puts in front; `null` while there is none. */
function errorMessage({ isError, error }: { isError: boolean; error: Error | null }): string | null {
  if (!isError || error === null) return null
  return (error instanceof ApiError ? fieldText(error.detail) : null) ?? error.message
}

/** Address, switch and, with an address, the state of the last runs. Without an address or with a broken settings.json only address and switch. */
export function FetchForm({ fetch, now, input }: { fetch: Fetch; now: number; input?: Ref<HTMLInputElement> }) {
  const { t } = useTranslation()
  const ids = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const saveAddress = useSaveFetchSettings()
  const saveSwitch = useSaveFetchSettings()
  const value = draft ?? fetch.address
  const changed = draft !== null && draft !== fetch.address
  const lock = fetchLock(fetch)
  // The switch needs an address and a readable file; without the capability `fetch` there is no dialog.
  const reason = lock === null ? null : t(`import.fetch.reason.${lock === "broken" ? "brokenSwitch" : lock}`)
  const enabled = saveSwitch.isPending ? saveSwitch.variables.enabled : fetch.enabled
  const errorId = `${ids}-address-error`
  const switchErrorId = `${ids}-switch-error`
  // One save at a time: a second click while one runs would send the other control's stale value (Konventionen §7).
  const busy = saveAddress.isPending || saveSwitch.isPending
  const addressError = errorMessage(saveAddress)
  const switchError = errorMessage(saveSwitch)

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!changed) return
    if (busy) return
    try {
      // "Speichern" sends the stored switch and the switch sends the stored address: each control saves its own value only.
      saveSwitch.reset()
      await saveAddress.mutateAsync({ address: value, enabled: fetch.enabled })
      // The status has reloaded by now (the hook waits for it), so the field shows the stored address.
      setDraft(null)
    } catch {
      // The text of the refusal is shown at the field, the draft stays.
    }
  }

  return (
    <>
      {fetch.settings_error !== null && (
        <p>
          <Warn>{t("import.fetch.dialog.settingsError", { error: fetch.settings_error })}</Warn>
        </p>
      )}
      <Facts>
        <Fact term={t("import.fetch.dialog.address")} center>
          <AddressField
            input={input}
            value={value}
            changed={changed}
            pending={busy}
            error={addressError}
            errorId={errorId}
            onChange={(next) => {
              setDraft(next)
              // A reset of a save in flight would unlock the controls too early; only a settled refusal goes.
              if (busy) return
              saveAddress.reset()
              saveSwitch.reset()
            }}
            onSubmit={(e) => void submit(e)}
          />
        </Fact>
        <Fact term={t("import.fetch.dialog.switch")} center>
          <span className="inline-flex h-5 items-center gap-2">
            <ReasonPopover
              reason={reason}
              child={
                <Switch
                  checked={enabled}
                  aria-label={t("import.fetch.dialog.switch")}
                  aria-disabled={reason !== null || undefined}
                  // While a save runs the switch only ignores a click: it keeps its look and its focus.
                  aria-busy={busy || undefined}
                  aria-describedby={switchError !== null ? switchErrorId : undefined}
                  aria-invalid={switchError !== null || undefined}
                  onCheckedChange={(on) => {
                    if (reason !== null || busy) return
                    // Each control shows the refusal of its own last save only.
                    saveAddress.reset()
                    saveSwitch.mutate({ address: fetch.address, enabled: on })
                  }}
                />
              }
            />
            <span>{t(enabled ? "import.fetch.dialog.on" : "import.fetch.dialog.off")}</span>
          </span>
          {switchError !== null && <FieldError id={switchErrorId}>{switchError}</FieldError>}
        </Fact>
        {fetch.address !== "" && fetch.settings_error === null && <FetchFacts fetch={fetch} now={now} />}
      </Facts>
    </>
  )
}

interface AddressFieldProps {
  input?: Ref<HTMLInputElement>
  value: string
  /** The text differs from the stored address: only then "Speichern" is usable (Enter included). */
  changed: boolean
  pending: boolean
  /** The text of the API's refusal (422), shown under the field. */
  error: string | null
  errorId: string
  onChange: (value: string) => void
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void
}

/** Address field and "Speichern" with the refusal under the field. */
export function AddressField({ input, value, changed, pending, error, errorId, onChange, onSubmit }: AddressFieldProps) {
  const { t } = useTranslation()
  return (
    <>
      {/* 8 px between field and button, so the focus outline of the field does not touch the button. */}
      <form className="flex w-full max-w-[340px] items-center gap-2 max-sm:max-w-none" onSubmit={onSubmit} noValidate>
        <Input
          ref={input}
          name="address"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t("import.fetch.dialog.placeholder")}
          aria-label={t("import.fetch.dialog.addressLabel")}
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? errorId : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!changed || pending}>
          {t("import.fetch.dialog.save")}
        </Button>
      </form>
      {error !== null && <FieldError id={errorId}>{error}</FieldError>}
    </>
  )
}

const MUTED = <span className="text-muted-foreground">{"–"}</span>

/** "Letzte neue Datei", "Letzter Fehler" (only with one) and "Nächster Abruf". */
export function FetchFacts({ fetch, now }: { fetch: Fetch; now: number }) {
  const { t } = useTranslation()
  const saved = fetch.last_saved_at
  const clock = saved === null ? null : formatRunClock(saved)
  const age = saved === null ? null : formatAge(saved, now)
  const savedText =
    saved === null ? (
      <span className="text-muted-foreground">{t("import.fetch.dialog.noFile")}</span>
    ) : (
      <>
        {[clock, age].filter((part) => part !== null).join(", ")}
        {fetch.last_saved_name !== null && (
          <>
            {" "}
            <code className={`${CODE} whitespace-nowrap`}>{fetch.last_saved_name}</code>
          </>
        )}
      </>
    )
  // Today only the time, an older error with its date like "Letzter Lauf".
  const errorClock = fetch.last_error_at === null ? null : formatRunStamp(fetch.last_error_at, now)
  const next = fetch.next_run === null ? null : formatRunClock(fetch.next_run)
  return (
    <>
      <Fact term={t("import.fetch.dialog.lastFile")}>{saved !== null && fetch.enabled && fetchStale(fetch, now) ? <Warn>{savedText}</Warn> : savedText}</Fact>
      {fetch.last_error !== null && (
        <Fact term={t("import.fetch.dialog.lastError")}>
          {errorClock !== null && `${errorClock} `}
          <Warn>{fetch.last_error}</Warn>
        </Fact>
      )}
      <Fact term={t("import.fetch.dialog.next")}>{next ?? MUTED}</Fact>
    </>
  )
}
