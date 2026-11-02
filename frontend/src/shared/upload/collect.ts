/** Only `.dta` goes up, in any case (same rule as `list_dta` in the backend). */
export function isDta(name: string): boolean {
  return /\.dta$/i.test(name)
}

/** A drag carries files, not text or a link from another window. */
export function hasFiles(dt: DataTransfer | null): boolean {
  return dt !== null && Array.from(dt.types).includes("Files")
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await entryFile(entry as FileSystemFileEntry))
    return
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // One call returns only part of a folder; an empty answer ends it.
  for (;;) {
    const batch = await readEntries(reader)
    if (batch.length === 0) break
    for (const e of batch) await walk(e, out)
  }
}

/**
 * Every file of a drop, folders searched with their subfolders. Everything is taken from the event
 * before the first `await`: afterwards the DataTransfer is empty. Single files come from `getAsFile`,
 * because in WebKit `entry.file()` fails on a dropped file; entries are for folders only. Throws when a
 * folder cannot be read; the caller tells the user.
 */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const picked = Array.from(dt.items)
    .filter((item) => item.kind === "file")
    .map((item) => ({ entry: item.webkitGetAsEntry(), file: item.getAsFile() }))
  if (picked.length === 0) return Array.from(dt.files)
  const out: File[] = []
  for (const p of picked) {
    if (p.entry?.isDirectory) await walk(p.entry, out)
    else if (p.file) out.push(p.file)
  }
  return out
}
