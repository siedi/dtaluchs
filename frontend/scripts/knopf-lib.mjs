// The measure of a button against the rules of the look (kinds, sizes, ground, frame, text at rest, on hover and disabled), shared by
// bausteine.mjs (the buttons the app shows) and the checks of a host that shows the other kinds and sizes.
// Tokens are resolved by the page itself (`getComputedStyle`), so tokens and mixes come out in the same notation.

const mixOf = (token, pct, other) => `color-mix(in srgb, var(${token}) ${pct}%, var(${other}))`
const GONE = "transparent"

/** Per kind: rest `[ground, frame, text]`, the ground on hover (`hoverText`: the text on hover, where it changes), disabled `[ground, frame, text]`; `--x` is a token, anything else CSS. */
export const KINDS = {
  default: { rest: ["--accent", "--accent", "--on-accent"], hover: mixOf("--accent", 86, "--text"), off: ["--surface-2", "--border", "--text-3"] },
  outline: { rest: ["--surface", "--border-strong", "--text"], hover: "var(--surface-2)", off: ["--surface-2", "--border", "--text-3"] },
  ghost: { rest: [GONE, GONE, "--text"], hover: "var(--surface-2)", off: [GONE, GONE, "--text-3"] },
  link: { rest: [GONE, GONE, "--link"], hover: GONE, off: [GONE, GONE, "--text-3"] },
  destructive: { rest: ["--destructive", "--destructive", "--on-accent"], hover: mixOf("--destructive", 86, "--text"), off: ["--surface-2", "--border", "--text-3"] },
  "destructive-outline": { rest: ["--surface", "--destructive", "--destructive"], hover: mixOf("--destructive", 12, "--surface"), hoverText: mixOf("--destructive", 90, "--text"), off: ["--surface-2", "--border", "--text-3"] },
}

/** Per size: height, width (null: free) and horizontal padding (null: none given); `round`: a full radius instead of 6 px. */
export const SIZES = { default: { h: 28, w: null, px: 8 }, sm: { h: 24, w: null, px: 8 }, icon: { h: 28, w: 28, px: null }, "icon-sm": { h: 24, w: 24, px: null }, info: { h: 20, w: 20, px: 0, round: true }, link: { h: null, w: null, px: 0 } }

/** What the page makes of each CSS expression (`--token` or any colour) as ground and as text, in the notation of `getComputedStyle`. */
export const resolveColors = (page, exprs) => page.evaluate((list) => list.map((expr) => {
  const i = document.createElement("i")
  i.style.cssText = `background-color:${expr.startsWith("--") ? `var(${expr})` : expr};color:${expr.startsWith("--") ? `var(${expr})` : expr}`
  document.body.append(i)
  const c = getComputedStyle(i)
  const out = { bg: c.backgroundColor, text: c.color }
  i.remove()
  return out
}), exprs)

/** Resolves when the animations of the first element matching `selector` (and its children) are over. */
export const animationsDone = (page, selector) =>
  page.waitForFunction((sel) => document.querySelector(sel).getAnimations({ subtree: true }).every((a) => a.playState === "finished"), selector)

const near = (a, b) => Math.abs(a - b) < 0.5

/**
 * Measures the button `el` (a locator) of `kind` and `size` and throws one error naming every deviation. `off` is a locator
 * of the same kind and size that is disabled on the page; without it the button itself is set to `disabled`. `ownText`: the
 * text colour of the place, not of the kind (a ghost in a head that sets its own). `disabled`: the caller expects the button
 * to be disabled already (the app shows it so); then there is no rest and no hover to measure. Any other disabled button is an
 * error, not a skipped case. Returns the values at rest.
 */
export async function checkButton(page, el, { kind, size, label, ownText = false, off = null, disabled = false, log = () => {} }) {
  const settled = (e = el) => e.evaluate((n) => Promise.all(n.getAnimations().map((x) => x.finished)))
  const read = (e = el) => e.evaluate((n) => {
    const cs = getComputedStyle(n)
    const r = n.getBoundingClientRect()
    return { h: r.height, w: r.width, pl: parseFloat(cs.paddingLeft), pr: parseFloat(cs.paddingRight), radius: cs.borderTopLeftRadius, bw: cs.borderTopWidth, bg: cs.backgroundColor, border: cs.borderTopColor, color: cs.color, disabled: n.disabled }
  })
  const k = KINDS[kind]
  const sz = SIZES[size]
  const [exBg, exBorder, exText, exHover, exOffBg, exOffBorder, exOffText, exHoverText] = (await resolveColors(page, [k.rest[0], k.rest[1], k.rest[2], k.hover, k.off[0], k.off[1], k.off[2], k.hoverText ?? k.rest[2]])).map((r, i) => (i === 2 || i === 6 || i === 7 ? r.text : r.bg))
  await page.mouse.move(0, 0)
  await settled()
  const rest = await read()
  log(label, JSON.stringify(rest))
  const bad = []
  if (sz.h !== null && !near(rest.h, sz.h)) bad.push(`height ${rest.h}, expected ${sz.h}`)
  if (sz.w !== null && !near(rest.w, sz.w)) bad.push(`width ${rest.w}, expected ${sz.w}`)
  if (sz.px !== null && (!near(rest.pl, sz.px) || !near(rest.pr, sz.px))) bad.push(`padding ${rest.pl}/${rest.pr}, expected ${sz.px}`)
  if (sz.round ? parseFloat(rest.radius) < sz.h : size !== "link" && rest.radius !== "6px") bad.push(`radius ${rest.radius}, expected ${sz.round ? "round" : "6px"}`)
  if (rest.bw !== (kind === "link" ? "0px" : "1px")) bad.push(`frame ${rest.bw}`)
  // A button the app itself shows disabled (the "Zurück" arrow without a history) has no rest to measure; the caller says so.
  if (rest.disabled !== disabled) bad.push(rest.disabled ? "the button is disabled, the caller expected it enabled" : "the button is enabled, the caller expected it disabled")
  if (!rest.disabled) {
    if (rest.bg !== exBg) bad.push(`ground ${rest.bg}, expected ${exBg}`)
    if (kind !== "link" && rest.border !== exBorder) bad.push(`frame colour ${rest.border}, expected ${exBorder}`)
    // The text of a ghost is the one of its place (here the icons of the chart head set text-2 themselves).
    if (!ownText && rest.color !== exText) bad.push(`text ${rest.color}, expected ${exText}`)
    await el.hover()
    await settled()
    const hover = await read()
    if (hover.bg !== exHover) bad.push(`hover ground ${hover.bg}, expected ${exHover}`)
    if (!ownText && hover.color !== exHoverText) bad.push(`hover text ${hover.color}, expected ${exHoverText}`)
    await page.mouse.move(0, 0)
  }
  if (!off) await el.evaluate((e) => { e.disabled = true })
  const target = off ?? el
  await settled(target)
  const gone = await read(target)
  if (off) {
    if (!gone.disabled) bad.push("the disabled button is not disabled")
    // The disabled button has the size of its kind as well.
    if (sz.h !== null && !near(gone.h, sz.h)) bad.push(`disabled height ${gone.h}, expected ${sz.h}`)
  }
  if (gone.bg !== exOffBg) bad.push(`disabled ground ${gone.bg}, expected ${exOffBg}`)
  if (kind !== "link" && gone.border !== exOffBorder) bad.push(`disabled frame ${gone.border}, expected ${exOffBorder}`)
  if (gone.color !== exOffText) bad.push(`disabled text ${gone.color}, expected ${exOffText}`)
  if (bad.length) throw new Error(`${label}: ${bad.join("; ")}`)
  return rest
}
