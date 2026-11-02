// A real mouse click for the check scripts: the pointer moves in steps, then presses and releases.

/** Resolves once the scroll position held for six frames, at the latest after 2 s; a navigation ends the wait too. */
const scrollStill = (page) =>
  page
    .evaluate(() => new Promise((done) => {
      setTimeout(done, 2000)
      let last = scrollY
      let same = 0
      const frame = () => {
        if (scrollY === last) same++
        else (last = scrollY), (same = 0)
        if (same >= 6) done()
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }))
    .catch(() => {})

/**
 * Clicks `loc` with the mouse. In WebKit the start page scrolled a second time after `scrollIntoViewIfNeeded`
 * (14 of 85 runs of "Zum Abruf: landet" in abruf.mjs), the click then hit
 * the section above and went to /series: it waits for the scroll to rest and takes up to three tries until the target
 * lies under the pointer. After that it presses anyway, so a target that something covers fails in the check of the
 * case, not here.
 */
export async function mclick(page, loc) {
  for (let trial = 1; trial <= 3; trial++) {
    await loc.scrollIntoViewIfNeeded()
    await scrollStill(page)
    const b = await loc.boundingBox()
    if (!(b && b.width > 0 && b.height > 0)) throw new Error(`Ziel hat eine Fläche: ${loc}`)
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    await page.mouse.move(x - 20, y - 10)
    await page.mouse.move(x, y, { steps: 5 })
    if (await loc.evaluate((e, [x, y]) => e.contains(document.elementFromPoint(x, y)), [x, y])) break
  }
  await page.mouse.down()
  await page.mouse.up()
}
