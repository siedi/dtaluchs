// Reads the pixels of a PNG from Playwright's `page.screenshot` (8 bit, RGB or RGBA, not interlaced): the check of
// what is painted on top of what needs the pixel, not a computed style.
import { inflateSync } from "node:zlib"

/** `{ width, height, at(x, y) -> [r, g, b, a] }` */
export function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let channels = 4
  const data = []
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString("ascii", pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + length)
    if (type === "IHDR") {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0) throw new Error("PNG: only 8 bit and not interlaced")
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0
      if (!channels) throw new Error(`PNG: colour type ${body[9]}`)
    } else if (type === "IDAT") data.push(body)
    pos += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      out[y * stride + x] = (v + [0, a, b, (a + b) >> 1, paeth][filter]) & 255
    }
  }
  return { width, height, at: (x, y) => [0, 1, 2, 3].map((k) => (k < channels ? out[y * stride + x * channels + k] : 255)) }
}
