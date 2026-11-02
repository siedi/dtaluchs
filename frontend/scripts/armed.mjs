// Shared by the check scripts: waits until Radix has armed its listeners after a menu opened (or a click went through).
/** Radix adds its click-away listener in a timer after the menu is mounted: wait for a frame and then for a timer queued after it. */
export const armed = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done))))
