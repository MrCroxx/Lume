import type { FileEntry } from '../types'

export type FileSortField = 'name' | 'size' | 'modified_at'
export type SortDirection = 'asc' | 'desc'

export interface FileSort {
  field: FileSortField
  direction: SortDirection
}

export const DEFAULT_FILE_SORT: FileSort = {
  field: 'name',
  direction: 'asc',
}

const DEFAULT_DIRECTION_BY_FIELD: Record<FileSortField, SortDirection> = {
  name: 'asc',
  size: 'desc',
  modified_at: 'desc',
}

const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function toggleFileSort(current: FileSort, field: FileSortField): FileSort {
  if (current.field === field) {
    return {
      field,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    }
  }
  return {
    field,
    direction: DEFAULT_DIRECTION_BY_FIELD[field],
  }
}

export function sortFileEntries(entries: readonly FileEntry[], sort: FileSort): FileEntry[] {
  const direction = sort.direction === 'asc' ? 1 : -1
  return [...entries].sort((left, right) => {
    const leftIsDirectory = left.kind === 'directory'
    const rightIsDirectory = right.kind === 'directory'
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1
    }

    let primary = 0
    if (sort.field === 'name') {
      primary = compareName(left, right) * direction
    } else if (sort.field === 'size') {
      if (!leftIsDirectory) {
        primary = (left.size - right.size) * direction
      }
    } else if (sort.field === 'modified_at') {
      primary = compareModifiedAt(left.modified_at, right.modified_at, direction)
    }

    if (primary !== 0) return primary
    return compareFallback(left, right)
  })
}

function compareName(left: FileEntry, right: FileEntry): number {
  const collated = nameCollator.compare(left.name, right.name)
  if (collated !== 0) return collated
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  return 0
}

function compareFallback(left: FileEntry, right: FileEntry): number {
  const byName = compareName(left, right)
  if (byName !== 0) return byName
  if (left.path === right.path) return 0
  return left.path < right.path ? -1 : 1
}

function compareModifiedAt(
  left: string | null,
  right: string | null,
  direction: 1 | -1,
): number {
  const leftTime = parseTimestamp(left)
  const rightTime = parseTimestamp(right)
  if (leftTime === null && rightTime === null) return 0
  if (leftTime === null) return 1
  if (rightTime === null) return -1
  if (leftTime === rightTime) return 0
  return (leftTime - rightTime) * direction
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}
