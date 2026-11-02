// Stand-ins for `localStorage` in tests of code that keeps something in the browser (theme, shape of the start page).

/** A storage in memory, empty at the start. */
export function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

/** A storage the browser blocks: every read and write throws. */
export const throwing = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError")
  },
  setItem: () => {
    throw new DOMException("blocked", "SecurityError")
  },
}
