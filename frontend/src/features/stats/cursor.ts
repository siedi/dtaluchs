import { createCursor, useCursor } from "@/shared/chart/cursor"

const cursor = createCursor()

export const setCursorRow = cursor.set
export const useCursorRow = () => useCursor(cursor)
