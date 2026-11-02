import { useId } from "react"
import logo from "@/assets/logo.svg?raw"

const MASK_ID = "luchs-kopf-maske"

/**
 * The lynx head in the page head: inline so that `currentColor` follows the text colour of
 * the parent, 24 px high, in `--brand`. Decoration only; the name next to it is the text.
 * The mask of the SVG gets an id of its own per use: with the same id twice in one document, a `display: none`
 * copy that comes first takes the mask with it and the other one is drawn without it.
 */
export function Logo() {
  const id = `${MASK_ID}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const html = logo.replaceAll(MASK_ID, id)
  return <span aria-hidden className="text-brand inline-flex size-6 shrink-0 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: html }} />
}
