/**
 * Cells of a table: a row is 28 px, the head is 12 px at weight 500 on --surface-2, a cell is padded 12 px
 * at the sides, has a line on top and its text sits in the middle (a cell that needs the top for a block of lines sets
 * `align-top` itself). A table sets `border-separate border-spacing-0` so the height of a cell includes its line.
 */
export const TH = "bg-surface-2 text-text-2 h-7 px-3 text-xs font-medium whitespace-nowrap"
export const TD = "border-border h-7 border-t px-3 align-middle"
/**
 * The frame of a table: a line of --border, radius 10 px, the content does not pass the corners
 * (so the head ground is rounded with them); a table wider than the frame scrolls inside it and the frame stays.
 */
export const TABLE_FRAME = "border-border bg-surface overflow-x-auto rounded-lg border"
export const TABLE_BASE = "border-separate border-spacing-0 text-base"
