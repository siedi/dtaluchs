import { describe, expect, it } from "vitest"
import { cn } from "cn"
import { buttonVariants } from "./button"

// Heights and padding of the button per kind and size:
// 28 px (default, icon), 24 px (sm, icon-sm), 20 px round (info); horizontal padding 8 px.

type Variant = "default" | "outline" | "ghost" | "link" | "destructive" | "destructive-outline"
const classes = (variant: Variant, size: "default" | "sm" | "icon" | "icon-sm" | "info") =>
  buttonVariants({ variant, size }).split(/\s+/)

describe("buttonVariants, sizes", () => {
  it("default is 28 px high with 8 px padding", () => {
    const c = classes("outline", "default")
    expect(c).toContain("h-7")
    expect(c).toContain("px-2")
  })

  it("sm is 24 px high with 8 px padding", () => {
    const c = classes("outline", "sm")
    expect(c).toContain("h-6")
    expect(c).toContain("px-2")
  })

  it("icon is 28 px square, icon-sm 24 px", () => {
    expect(classes("ghost", "icon")).toContain("size-7")
    expect(classes("ghost", "icon-sm")).toContain("size-6")
  })

  it("info is 20 px and round", () => {
    const c = classes("outline", "info")
    expect(c).toContain("size-5")
    expect(c).toContain("rounded-full")
  })

  it("has no other size", () => {
    const sizes = ["xs", "lg", "icon-xs", "icon-lg"]
    for (const size of sizes) {
      const c = buttonVariants({ size: size as never }).split(/\s+/)
      expect(c.some((k) => /^(h|size)-\d+$/.test(k))).toBe(false)
    }
  })
})

describe("buttonVariants, kinds", () => {
  it("main is the house colour", () => {
    const c = classes("default", "default")
    expect(c).toContain("bg-primary")
    expect(c).toContain("text-primary-foreground")
  })

  it("normal has the strong border on the surface", () => {
    const c = classes("outline", "default")
    expect(c).toContain("border-border-strong")
    expect(c).toContain("bg-surface")
  })

  it("ghost has no border and no fill at rest", () => {
    const c = classes("ghost", "default")
    expect(c).not.toContain("border-border-strong")
    expect(c.some((k) => /^bg-/.test(k))).toBe(false)
  })

  it("draws no ring of its own, focus comes from the base style", () => {
    for (const v of ["default", "outline", "ghost", "link"] as const) {
      expect(buttonVariants({ variant: v }).includes("ring")).toBe(false)
      expect(buttonVariants({ variant: v }).includes("shadow")).toBe(false)
    }
  })

  it("a locked button draws like a disabled one (aria-disabled)", () => {
    const c = classes("default", "default")
    expect(c).toContain("disabled:bg-surface-2")
    expect(c).toContain("aria-disabled:bg-surface-2")
  })
})

describe("buttonVariants, link", () => {
  it("is text: neither the height nor the padding of the size apply", () => {
    for (const size of ["default", "sm"] as const) {
      const c = cn(buttonVariants({ variant: "link", size })).split(/\s+/)
      expect(c).toContain("h-auto")
      expect(c).toContain("p-0")
      expect(c).not.toContain("h-7")
      expect(c).not.toContain("h-6")
      expect(c).not.toContain("px-2")
    }
  })
})

describe("buttonVariants, kinds for deleting", () => {
  it("destructive: fill and frame --destructive, text --on-accent, hover mixes 86 % with --text", () => {
    const c = classes("destructive", "default")
    expect(c).toContain("border-destructive")
    expect(c).toContain("bg-destructive")
    expect(c).toContain("text-on-accent")
    expect(c).toContain("hover:bg-[color-mix(in_srgb,var(--destructive)_86%,var(--text))]")
  })

  it("destructive-outline: frame and text --destructive on --surface, hover and open mix 12 % with --surface", () => {
    const c = classes("destructive-outline", "default")
    const mix = "bg-[color-mix(in_srgb,var(--destructive)_12%,var(--surface))]"
    expect(c).toContain("border-destructive")
    expect(c).toContain("text-destructive")
    expect(c).toContain("bg-surface")
    expect(c).toContain(`hover:${mix}`)
    expect(c).toContain(`aria-expanded:${mix}`)
    // The text turns darker on hover and open, 90 % --destructive with --text (4.5:1 on the ground of the hover).
    const text = "text-[color-mix(in_srgb,var(--destructive)_90%,var(--text))]"
    expect(c).toContain(`hover:${text}`)
    expect(c).toContain(`aria-expanded:${text}`)
  })

  it("both are 28 px high in size default and 24 px in sm, 8 px padding", () => {
    for (const v of ["destructive", "destructive-outline"] as const) {
      const d = classes(v, "default")
      expect(d).toContain("h-7")
      expect(d).toContain("px-2")
      const s = classes(v, "sm")
      expect(s).toContain("h-6")
      expect(s).toContain("px-2")
    }
  })

  it("both draw disabled and locked like main and normal (--border, --surface-2, grey text)", () => {
    for (const v of ["destructive", "destructive-outline"] as const) {
      const c = classes(v, "default")
      for (const k of ["disabled:border-border", "disabled:bg-surface-2", "aria-disabled:border-border", "aria-disabled:bg-surface-2", "aria-disabled:hover:bg-surface-2", "disabled:text-text-3", "aria-disabled:text-text-3"]) {
        expect(c).toContain(k)
      }
    }
  })

  it("destructive-outline: locked or disabled wins over open (aria-expanded)", () => {
    const c = classes("destructive-outline", "default")
    expect(c).toContain("aria-disabled:aria-expanded:bg-surface-2")
    expect(c).toContain("disabled:aria-expanded:bg-surface-2")
    expect(c).toContain("aria-disabled:aria-expanded:text-text-3")
    expect(c).toContain("aria-disabled:hover:text-text-3")
  })

  it("draw no ring and no shadow of their own", () => {
    for (const v of ["destructive", "destructive-outline"] as const) {
      expect(buttonVariants({ variant: v }).includes("ring")).toBe(false)
      expect(buttonVariants({ variant: v }).includes("shadow")).toBe(false)
    }
  })
})
