import { createElement, Fragment } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Logo } from "./Logo"

// A mask id that two inline SVGs share breaks the second one as soon as the first is `display: none`.
describe("Logo", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, createElement(Logo), createElement(Logo)))
  const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1])
  const refs = [...html.matchAll(/mask="url\(#([^)]+)\)"/g)].map((m) => m[1])

  it("gives each use a mask id of its own", () => {
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it("points each use at its own mask", () => {
    expect(refs).toEqual(ids)
  })
})
