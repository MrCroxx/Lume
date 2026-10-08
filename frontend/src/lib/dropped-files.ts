export type UploadItem =
  | { kind: 'file'; path: string; file: File }
  | { kind: 'directory'; path: string }

export function isFileDrag(transfer: DataTransfer | null) {
  return !!transfer && Array.from(transfer.types).includes('Files')
}

export async function readDroppedItems(transfer: DataTransfer): Promise<UploadItem[]> {
  // Capture entries and files before the drop event's data store becomes protected.
  const sources = Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }))
  const fallbackFiles = Array.from(transfer.files)
  const result: UploadItem[] = []

  async function visit(entry: FileSystemEntry, parent: string) {
    const path = `${parent}${entry.name}`
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject)
      })
      result.push({ kind: 'file', path, file })
    } else if (entry.isDirectory) {
      result.push({ kind: 'directory', path: `${path}/` })
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      // Directory readers can return only part of a directory in each batch.
      while (true) {
        const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, reject)
        })
        if (!entries.length) break
        for (const child of entries) await visit(child, `${path}/`)
      }
    } else {
      throw new Error(`Unsupported dropped item: ${path}`)
    }
  }

  if (sources.length) {
    for (const source of sources) {
      if (source.entry) await visit(source.entry, '')
      else if (source.file) result.push({ kind: 'file', path: source.file.name, file: source.file })
      else throw new Error('Unable to read a dropped item. Try uploading files instead.')
    }
  } else {
    for (const file of fallbackFiles) result.push({ kind: 'file', path: file.name, file })
  }
  return result
}
