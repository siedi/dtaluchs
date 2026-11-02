// Measurement and judgement of inventur.mjs; see the head of that script.
/** Runs in the page (init script, `window.__cl`): colour helpers for the contrast measurement. */
export function colorLib() {
  const cv = document.createElement("canvas")
  cv.width = cv.height = 1
  const cx = cv.getContext("2d", { willReadFrequently: true })
  const cache = new Map()
  /** Any CSS colour as [r, g, b, a] (the canvas converts oklch(), color-mix() and friends to sRGB). */
  const rgba = (c) => {
    if (!cache.has(c)) {
      cx.clearRect(0, 0, 1, 1)
      cx.fillStyle = "#000"
      cx.fillStyle = c
      cx.fillRect(0, 0, 1, 1)
      const d = cx.getImageData(0, 0, 1, 1).data
      cache.set(c, [d[0], d[1], d[2], d[3] / 255])
    }
    return cache.get(c)
  }
  const over = (top, under) => [0, 1, 2].map((i) => top[3] * top[i] + (1 - top[3]) * under[i]).concat(1)
  const lum = (c) => {
    // Threshold 0.04045 as in shared/chart/theme.ts (WCAG 2.x, sRGB linearisation); this runs in the page and cannot import it.
    const f = (v) => {
      const s = v / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const bgCache = new Map()
  /** The ground of `el`: its own and its ancestors' backgrounds blended down to the first opaque one (page: white). */
  const ground = (el) => {
    if (!el) return [255, 255, 255, 1]
    if (bgCache.has(el)) return bgCache.get(el)
    const own = rgba(getComputedStyle(el).backgroundColor)
    const result = own[3] >= 1 ? own : over(own, ground(el.parentElement))
    bgCache.set(el, result)
    return result
  }
  const opacity = (el) => {
    let o = 1
    for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity)
    return o
  }
  const str = (c) => `rgb(${c.slice(0, 3).map(Math.round).join(", ")})`
  const key = (c) => `${str(c)}/${c[3].toFixed(2)}`
  return { key, rgba, over, ratio, ground, opacity, str, reset: () => bgCache.clear() }
}

/** Runs in the page: one record per visible element. */
export function collect() {
  const INTERACTIVE = 'button,[role=radio],[role=tab],nav a,header a,input,textarea,[role=combobox],[role^=menuitem],[role=option],[data-slot=command-item]'
  const CONTROL = 'button:not([role=tab]),[role=radio],input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]),[role=combobox],[role^=menuitem]'
  const L = window.__cl
  L.reset()
  // The traffic-light colours are exempt from the contrast measurement (a symbol beside a word, never colour alone;
  // dataviz skill: status colours under 3:1 on light): `--ok`, `--warn`, `--crit` only, compared
  // with their alpha, and never a colour that a text token (`--text`, `--text-2`, `--text-3`, `--accent`, `--mark`,
  // `--link`, `--on-accent`) has as well. `--drop` and `--no` are translucent areas, not text colours.
  const probe = document.createElement("span")
  document.body.appendChild(probe)
  const tokenColor = (v) => {
    probe.style.color = `var(${v}, transparent)`
    const c = L.rgba(getComputedStyle(probe).color)
    return c[3] === 0 ? null : L.key(c)
  }
  const plain = new Set(["--text", "--text-2", "--text-3", "--accent", "--mark", "--link", "--on-accent", "--foreground", "--muted-foreground", "--primary"].map(tokenColor).filter(Boolean))
  const ampel = new Set(["--ok", "--warn", "--crit"].map(tokenColor).filter((k) => k && !plain.has(k)))
  // The bar at the bottom below 640 px: `main` keeps its height free under the content. The step of the
  // spacing is what stands above it; the browser resolves `calc()` and `env()` when the probe's height is read.
  probe.style.cssText = "position: absolute; height: var(--nav-bottom-height, 0px)"
  const navBottom = Math.round(probe.getBoundingClientRect().height * 100) / 100
  probe.remove()
  const FIELD = "input:not([type=checkbox],[type=radio],[type=hidden],[type=file],[type=range],[type=color],[type=button],[type=submit]),textarea"
  const px = (v) => (v.endsWith("px") ? Math.round(parseFloat(v) * 100) / 100 : null)
  const norm = (c) => (c === "rgba(0, 0, 0, 0)" || c === "transparent" ? null : c)
  const records = []
  const els = document.querySelectorAll("body *")
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    // `sr-only` text is a clipped 1 x 1 px box with a margin of -1 px: it is not on screen, so no step is measured
    if (r.width <= 1 && r.height <= 1) continue
    const cs = getComputedStyle(el)
    if (cs.display === "none" || cs.visibility === "hidden") continue
    if (["SCRIPT", "STYLE", "PATH", "LINE", "CIRCLE", "RECT", "G", "POLYLINE", "SVG"].includes(el.tagName.toUpperCase())) continue
    const slot = el.getAttribute("data-slot")
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : ""
    const sel = `${el.tagName.toLowerCase()}${slot ? `[${slot}]` : ""}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${cls ? "." + cls : ""}`
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ")
    let auto = [false, false, false, false]
    try {
      auto = ["top", "right", "bottom", "left"].map((s) => el.computedStyleMap().get(`margin-${s}`)?.value === "auto")
    } catch {
      // no typed OM (WebKit): the used value of an auto margin is counted
    }
    const bw = ["Top", "Right", "Bottom", "Left"].map((s) => px(cs[`border${s}Width`]) || 0)
    const hasBorder = bw.some((w) => w > 0) && cs.borderTopStyle !== "none"
    const rec = {
      sel,
      text: (own || el.getAttribute("aria-label") || "").slice(0, 28),
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      slot,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      interactive: el.matches(INTERACTIVE),
      pad: ["Top", "Right", "Bottom", "Left"].map((s) => px(cs[`padding${s}`]) || 0),
      mar: ["Top", "Right", "Bottom", "Left"].map((s, i) => (auto[i] ? 0 : px(cs[`margin${s}`]) || 0)),
      gap: [px(cs.rowGap) || 0, px(cs.columnGap) || 0],
      radius: cs.borderTopLeftRadius,
      radiusAll: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
      border: hasBorder ? bw.join("/") : "0",
      borderColor: hasBorder ? norm(cs.borderTopColor) : null,
      shadow: cs.boxShadow === "none" ? null : cs.boxShadow,
      bg: norm(cs.backgroundColor),
      display: cs.display,
      control: el.matches(CONTROL),
      off: !!el.closest(':disabled,[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])'),
    }
    // Under the bar the padding of `main` is the step above it plus the bar; the step alone is judged, and it must be a step
    // (0 or less leaves the end of the content under the bar).
    if (el.tagName === "MAIN" && navBottom > 0) {
      rec.aboveBar = Math.round((rec.pad[2] - navBottom) * 100) / 100
      rec.pad[2] = 0
    }
    if (rec.border !== "0" && el.matches("input,textarea,[role=combobox]") && rec.borderColor) {
      const ground = L.ground(el.parentElement)
      rec.borderRatio = Math.round(L.ratio(L.over(L.rgba(cs.borderTopColor), ground), ground) * 100) / 100
    }
    // Text colour: `color`, for SVG text `fill` (a fill that is no colour, e.g. a gradient, is not measured).
    // Input fields have no text node: the value is measured with `color`, the placeholder with ::placeholder.
    const isField = el.matches(FIELD)
    const isSvgText = el.matches("text,tspan")
    if (own || isField) {
      const css = isSvgText ? cs.fill : cs.color
      const alpha = isSvgText ? parseFloat(cs.fillOpacity) : 1
      const measure = (cssColor, a, style) => {
        if (!/^(?:rgb|oklch|oklab|color|lab|lch|hsl|#)/.test(cssColor)) return null
        const bg = L.ground(el)
        const fg = [...L.rgba(cssColor)]
        const key = L.key(fg)
        fg[3] *= a * L.opacity(el)
        return { ratio: Math.round(L.ratio(L.over(fg, bg), bg) * 100) / 100, fg: L.str(fg), bg: L.str(bg), ampel: ampel.has(key), size: style.fontSize }
      }
      const contrast = measure(css, alpha, cs)
      if (contrast) rec.contrast = contrast
      rec.font = {
        family: cs.fontFamily.split(",")[0].replace(/"/g, ""),
        size: cs.fontSize,
        weight: cs.fontWeight,
        lh: cs.lineHeight,
        ls: cs.letterSpacing,
        color: css,
      }
      if (isField && el.placeholder && !el.value) {
        const ps = getComputedStyle(el, "::placeholder")
        const c = measure(ps.color, parseFloat(ps.opacity), ps)
        if (c) rec.extra = [{ sel: `${rec.sel}::placeholder`, text: el.placeholder.slice(0, 28), contrast: c, font: { size: ps.fontSize } }]
      }
    }
    records.push(rec)
  }
  const charts = [...document.querySelectorAll(".uplot")].map((u) => {
    const r = u.getBoundingClientRect()
    const c = u.querySelector("canvas")?.getBoundingClientRect()
    const legend = u.querySelector(".u-legend")
    return { w: r.width, h: r.height, canvasH: c?.height ?? null, legend: legend ? getComputedStyle(legend).fontSize : null }
  })
  const canv = [...document.querySelectorAll("canvas")].map((c) => ({ w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height }))
  return { records, charts, canv, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth }
}

/** Runs in the page: the focus indicator of the focused element. */
export function focusStyle() {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const cs = getComputedStyle(el)
  const L = window.__cl
  L.reset()
  const ground = L.ground(el.parentElement)
  const hasOutline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0
  return {
    form: hasOutline ? `${cs.outlineStyle} ${cs.outlineWidth} off ${cs.outlineOffset}` : cs.boxShadow !== "none" ? "Ring (box-shadow)" : "ohne",
    // A table row, a tile of the clipped tile grid and a target of the bar at the bottom take the offset -2 px: the frame
    // around them would cut the outline, the bar stands at the bottom edge of the window.
    inset: el.matches("tr,[role=row]") || Boolean(el.parentElement?.matches(".frame-inset-soft,[data-bottom-nav]")),
    ratio: hasOutline ? Math.round(L.ratio(L.over(L.rgba(cs.outlineColor), ground), ground) * 100) / 100 : null,
    el: `${el.tagName.toLowerCase()}${el.getAttribute("data-slot") ? `[${el.getAttribute("data-slot")}]` : ""}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}`,
    text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24),
    outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} off ${cs.outlineOffset}`,
    shadow: cs.boxShadow === "none" ? "none" : cs.boxShadow,
    border: `${cs.borderTopWidth} ${cs.borderTopColor}`,
    matchesFocusVisible: el.matches(":focus-visible"),
  }
}

/** Runs in the page: the focus indicator of the focused menu item and whether it is :focus-visible. */
export function menuItemFocus() {
  const el = document.activeElement
  const item = el?.closest("[role^=menuitem]")
  if (!item) return { isItem: false, el: el ? `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}` : "body" }
  const L = window.__cl
  L.reset()
  const menu = item.closest("[role=menu]")
  const items = [...menu.querySelectorAll("[role^=menuitem]")].filter((e) => !e.matches("[data-disabled]"))
  const cs = getComputedStyle(item)
  // The menu's own ground (the item's fill is not part of it: the outline is measured against the menu).
  const ground = L.ground(menu)
  const hasOutline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0
  return {
    isItem: true,
    index: items.indexOf(item),
    text: (item.textContent || "").trim().slice(0, 24),
    role: item.getAttribute("role"),
    variant: item.getAttribute("data-variant"),
    visible: item.matches(":focus-visible"),
    form: hasOutline ? `${cs.outlineStyle} ${cs.outlineWidth} off ${cs.outlineOffset}` : "ohne",
    ratio: hasOutline ? Math.round(L.ratio(L.over(L.rgba(cs.outlineColor), ground), ground) * 100) / 100 : null,
  }
}

export const newAgg = () => ({
  fontFamily: {}, fontSize: {}, fontWeight: {}, lineHeight: {}, letterSpacing: {}, fontStep: {},
  colorText: { light: {}, dark: {} }, colorBg: { light: {}, dark: {} }, colorBorder: { light: {}, dark: {} },
  radius: {}, radiusAll: {}, padding: {}, aboveBar: {}, margin: {}, gap: {}, shadow: {}, border: {},
  interactive: {}, cards: {}, charts: [], canvases: [], focus: [], menu: [], overflow: [], runs: [],
  controls: {}, contrastFail: {}, borderFail: {}, skipped: { disabled: 0, ampel: 0 },
  // States that did not come about (a popup that did not open, an error on the page): a gap in the inventory.
  missing: [],
})
export const bump = (map, key, ex) => {
  const e = (map[key] ??= { n: 0, ex: [] })
  e.n++
  if (e.ex.length < 3 && ex && !e.ex.includes(ex)) e.ex.push(ex)
}
const exOf = (r, ctx) => `${r.sel}${r.text ? ` "${r.text}"` : ""} @${ctx}`

export function ingest(data, ctx, theme, size, agg) {
  for (const r of data.records) {
    const ex = exOf(r, ctx)
    if (r.control) bump(agg.controls, `${r.h}`, ex)
    if (r.borderRatio !== undefined && r.borderRatio < 3) bump(agg.borderFail, `${theme} ${r.borderColor} gegen Grund: ${r.borderRatio}:1 (Ziel 3:1)`, ex)
    for (const x of [r, ...(r.extra ?? [])]) {
      if (!x.contrast) continue
      const size = x.font?.size ?? x.contrast.size
      const need = parseFloat(size) >= 20 ? 3 : 4.5
      if (r.off) agg.skipped.disabled++
      else if (x.contrast.ampel) agg.skipped.ampel++
      else if (x.contrast.ratio < need) bump(agg.contrastFail, `${theme} ${x.contrast.fg} auf ${x.contrast.bg}: ${x.contrast.ratio}:1 (${size}, Ziel ${need}:1)`, x === r ? ex : exOf(x, ctx))
    }
    for (const x of r.extra ?? []) bump(agg.fontSize, x.font.size, exOf(x, ctx))
    if (r.font) {
      bump(agg.fontFamily, r.font.family, ex)
      bump(agg.fontSize, r.font.size, ex)
      bump(agg.fontWeight, r.font.weight, ex)
      bump(agg.lineHeight, r.font.lh, ex)
      bump(agg.letterSpacing, r.font.ls, ex)
      bump(agg.fontStep, `${r.font.size} / ${r.font.weight} / ${r.font.lh}`, ex)
      bump(agg.colorText[theme], r.font.color, ex)
    }
    if (r.bg) bump(agg.colorBg[theme], r.bg, ex)
    if (r.borderColor) bump(agg.colorBorder[theme], r.borderColor, ex)
    if (r.radius !== "0px") bump(agg.radius, r.radius, ex)
    if (r.radius !== "0px") bump(agg.radiusAll, r.radiusAll.join(" "), ex)
    for (const v of r.pad) if (v) bump(agg.padding, `${v}px`, ex)
    if (r.aboveBar !== undefined) bump(agg.aboveBar, `${r.aboveBar}px`, ex)
    for (const v of r.mar) if (v) bump(agg.margin, `${v}px`, ex)
    for (const v of r.gap) if (v) bump(agg.gap, `${v}px`, ex)
    if (r.shadow) bump(agg.shadow, r.shadow, ex)
    if (r.border !== "0") bump(agg.border, r.border, ex)
    if (r.interactive) {
      const type = r.slot ?? `${r.tag}${r.role ? `[role=${r.role}]` : ""}`
      const key = `${type} | ${size}px`
      const e = (agg.interactive[key] ??= { n: 0, h: {}, wMin: Infinity, size: {}, pad: {}, radius: {}, border: {}, ex: [] })
      e.n++
      bump(e.h, `${r.h}`, ex)
      e.wMin = Math.min(e.wMin, r.w)
      if (r.font) bump(e.size, r.font.size, ex)
      bump(e.pad, r.pad.join(" "), ex)
      bump(e.radius, r.radius, ex)
      bump(e.border, r.border, ex)
      if (e.ex.length < 3) e.ex.push(ex)
    }
    const isCard = r.slot === "card" || (r.border !== "0" && r.radius !== "0px" && !r.interactive && r.w > 60 && r.h > 40)
    if (isCard) {
      const key = `${r.slot ?? "(Rahmen+Radius)"} | pad ${r.pad.join(" ")} | radius ${r.radius} | border ${r.border} | shadow ${r.shadow ? "ja" : "nein"}`
      bump(agg.cards, key, ex)
    }
  }
  for (const c of data.charts) agg.charts.push({ ctx, size, theme, ...c })
  for (const c of data.canv) agg.canvases.push({ ctx, size, theme, ...c })
  if (data.scrollW > data.innerW + 1) agg.overflow.push({ ctx, size, theme, scrollW: data.scrollW, innerW: data.innerW })
}


/**
 * Judges the aggregates of a run against the rules of the look (see the head of inventur.mjs). `agg` is the Chromium run, `wk` the
 * WebKit pass. Returns the lines to print and the number of distinct violating values.
 */
export function evaluate(agg, wk, title, wkSeconds) {
  const ALLOWED = { Schrift: [12, 13, 15, 20, 32], Abstand: [4, 8, 12, 16, 24, 32], Radius: [4, 6, 10], Steuerhöhe: [20, 24, 28] }
  const ok = (rule, v) => ALLOWED[rule].some((a) => Math.abs(a - v) < 0.01)
  const rules = {}
  const hit = (rule, value, n, ex) => {
    const list = (rules[rule] ??= new Map())
    const e = list.get(value) ?? { n: 0, ex: [] }
    e.n += n
    for (const x of ex ?? []) if (e.ex.length < 3 && !e.ex.includes(x)) e.ex.push(x)
    list.set(value, e)
  }
  for (const [key, e] of Object.entries(agg.fontSize)) if (!ok("Schrift", parseFloat(key))) hit("Schrift", key, e.n, e.ex)
  for (const kind of ["padding", "margin", "gap"]) {
    for (const [key, e] of Object.entries(agg[kind])) if (!ok("Abstand", Math.abs(parseFloat(key)))) hit("Abstand", `${kind} ${key}`, e.n, e.ex)
  }
  for (const [key, e] of Object.entries(agg.aboveBar)) if (!(parseFloat(key) > 0 && ok("Abstand", parseFloat(key)))) hit("Abstand", `padding unten über der Leiste ${key}`, e.n, e.ex)
  for (const [key, e] of Object.entries(agg.radiusAll)) {
    for (const part of new Set(key.split(" "))) {
      const v = parseFloat(part)
      if (v === 0 || part.endsWith("%") || v >= 1000 || ok("Radius", v)) continue
      hit("Radius", part, e.n, e.ex)
    }
  }
  // Every line height is a multiple of 4 px; "normal" is none.
  for (const [key, e] of Object.entries(agg.lineHeight)) {
    const v = parseFloat(key)
    if (!(Math.abs(v / 4 - Math.round(v / 4)) < 0.01)) hit("Zeilenhöhe", key, e.n, e.ex)
  }
  // A state that is missing was not measured: what lives only there (menus, popovers, the calendar) would pass unseen.
  for (const m of agg.missing) hit("Zustand", m, 1, [])
  for (const [key, e] of Object.entries(agg.controls)) if (!ok("Steuerhöhe", parseFloat(key))) hit("Steuerhöhe", `${key} px`, e.n, e.ex)
  const forms = new Set()
  for (const [label, list] of [["Chromium", agg.focus], ["WebKit", wk.focus]]) {
    for (const f of list) {
      if (!f.matchesFocusVisible && label === "WebKit") continue
      // a table row, a tile and a target of the bar take the offset -2 px by the spec: that is the same form, not a second one
      forms.add(f.inset && f.form === "solid 2px off -2px" ? "solid 2px off 2px" : f.form)
      const ex = [`${f.el}${f.text ? ` "${f.text}"` : ""} @${f.path} ${label}`]
      if (!(f.form === "solid 2px off 2px" || (f.inset && f.form === "solid 2px off -2px"))) hit("Fokus", `Form: ${f.form}`, 1, ex)
      else if (f.ratio !== null && f.ratio < 3) hit("Fokus", `Umriss gegen Grund ${f.ratio}:1 (Ziel 3:1)`, 1, ex)
    }
  }
  // Menu items take the one form of focus like everything else (outline 2 px, 2 px or -2 px inwards, 3:1 against the
  // menu ground), but only from the keyboard: an item under the mouse is focused and has no outline; one that the keyboard
  // reaches under a resting pointer has it (`rest`).
  for (const m of [...agg.menu, ...wk.menu]) {
    const ex = [`"${m.text}" @${m.ctx}`]
    if (m.mouse) {
      if (!m.isItem || m.index !== m.want) hit("Menüfokus", `Fokus bei der Maus nicht auf dem gezeigten Eintrag (${m.want}): ${m.isItem ? m.index : m.el}`, 1, ex)
      else if (m.form !== "ohne") hit("Menüfokus", `Umriss bei der Maus: ${m.form}`, 1, ex)
    } else if (m.rest && m.under !== m.text) hit("Menüfokus", `Zeiger ruht nicht über dem erreichten Eintrag: "${m.under}" statt "${m.text}"`, 1, [m.ctx])
    else if (m.rest && (!m.isItem || m.index !== m.want)) hit("Menüfokus", `Zeiger ruht, die Pfeiltaste hat den Eintrag darunter (${m.want}) nicht erreicht: ${m.isItem ? m.index : m.el}`, 1, [m.ctx])
    else if (!m.isItem) hit("Menüfokus", `Fokus nicht auf einem Eintrag: ${m.el}`, 1, [m.ctx])
    else if (!(m.form === "solid 2px off 2px" || m.form === "solid 2px off -2px")) hit("Menüfokus", `Form: ${m.form}`, 1, ex)
    else if (m.ratio < 3) hit("Menüfokus", `Umriss gegen den Menügrund ${m.ratio}:1 (Ziel 3:1)`, 1, ex)
  }
  if (forms.size > 1) hit("Fokus", `mehrere Formen: ${[...forms].join(" | ")}`, forms.size, [])
  for (const [label, a] of [["Chromium", agg], ["WebKit", wk]]) {
    for (const [key, e] of Object.entries(a.contrastFail)) hit("Kontrast", `${label} ${key}`, e.n, e.ex)
    for (const [key, e] of Object.entries(a.borderFail)) hit("Hinweis", `${label} Rahmen ${key}`, e.n, e.ex)
  }
  for (const o of agg.overflow) hit("Überlauf", `${o.ctx} ${o.size}px ${o.theme}: scrollWidth ${o.scrollW} > ${o.innerW}`, 1, [])

  const lines = []
  const order = ["Schrift", "Zeilenhöhe", "Abstand", "Radius", "Steuerhöhe", "Fokus", "Menüfokus", "Kontrast", "Überlauf", "Zustand"]
  const total = {}
  for (const rule of order) {
    const list = [...(rules[rule] ?? [])].sort((a, b) => b[1].n - a[1].n)
    total[rule] = [list.length, list.reduce((n, [, e]) => n + e.n, 0)]
    for (const [value, e] of list) lines.push(`${rule} | ${value} | ${e.n}x | ${e.ex.join("; ")}`)
  }
  // "Hinweis" lines are reported, not counted: they are not part of the exit code.
  const notes = [...(rules.Hinweis ?? [])].map(([value, e]) => `Hinweis | ${value} | ${e.n}x | ${e.ex.join("; ")}`)
  const out = [
    `Prüfung der Erscheinung gegen ${title}: ${agg.runs.length} Zustände Chromium, WebKit-Durchgang ${wkSeconds} s (${wk.runs.length} Zustände)`,
    `Kontrast ausgenommen: ${agg.skipped.disabled} Texte gesperrter Teile, ${agg.skipped.ampel} Texte in Ampelfarben (Chromium)`,
    ...lines,
    ...notes,
    "Zusammenfassung (verschiedene Werte / betroffene Elemente oder Stopps):",
    ...order.map((r) => `  ${r}: ${total[r][0]} / ${total[r][1]}`),
  ]
  return { out, bad: order.reduce((n, r) => n + total[r][0], 0) }
}
