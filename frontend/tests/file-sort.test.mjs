import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_FILE_SORT, sortFileEntries, toggleFileSort } from '../src/lib/file-sort.ts'

const entries = [
  { name: 'file10.txt', path: 'file10.txt', kind: 'file', size: 200, modified_at: '2026-01-03T00:00:00Z' },
  { name: 'file2.txt', path: 'file2.txt', kind: 'file', size: 5000, modified_at: '2026-01-01T00:00:00Z' },
  { name: 'alpha.txt', path: 'alpha.txt', kind: 'file', size: 200, modified_at: null },
  { name: 'Beta', path: 'Beta/', kind: 'directory', size: 0, modified_at: '2026-01-02T00:00:00Z' },
  { name: 'alpha-dir', path: 'alpha-dir/', kind: 'directory', size: 0, modified_at: '2026-01-04T00:00:00Z' },
]

test('toggleFileSort flips direction on the active field and uses sensible defaults on switch', () => {
  assert.deepEqual(DEFAULT_FILE_SORT, { field: 'name', direction: 'asc' })
  assert.deepEqual(toggleFileSort(DEFAULT_FILE_SORT, 'name'), { field: 'name', direction: 'desc' })
  assert.deepEqual(toggleFileSort({ field: 'name', direction: 'desc' }, 'name'), { field: 'name', direction: 'asc' })
  assert.deepEqual(toggleFileSort(DEFAULT_FILE_SORT, 'size'), { field: 'size', direction: 'desc' })
  assert.deepEqual(toggleFileSort({ field: 'size', direction: 'desc' }, 'size'), { field: 'size', direction: 'asc' })
  assert.deepEqual(toggleFileSort(DEFAULT_FILE_SORT, 'modified_at'), { field: 'modified_at', direction: 'desc' })
  assert.deepEqual(toggleFileSort({ field: 'modified_at', direction: 'desc' }, 'modified_at'), { field: 'modified_at', direction: 'asc' })
  assert.deepEqual(toggleFileSort({ field: 'size', direction: 'desc' }, 'name'), { field: 'name', direction: 'asc' })
})

test('sortFileEntries keeps directories first and sorts naturally by name ascending and descending', () => {
  const asc = sortFileEntries(entries, { field: 'name', direction: 'asc' })
  assert.deepEqual(
    asc.map((entry) => entry.name),
    ['alpha-dir', 'Beta', 'alpha.txt', 'file2.txt', 'file10.txt'],
  )

  const desc = sortFileEntries(entries, { field: 'name', direction: 'desc' })
  assert.deepEqual(
    desc.map((entry) => entry.name),
    ['Beta', 'alpha-dir', 'file10.txt', 'file2.txt', 'alpha.txt'],
  )
})

test('sortFileEntries sorts files by size while keeping directories ordered by name first', () => {
  const desc = sortFileEntries(entries, { field: 'size', direction: 'desc' })
  assert.deepEqual(
    desc.map((entry) => entry.name),
    ['alpha-dir', 'Beta', 'file2.txt', 'alpha.txt', 'file10.txt'],
  )

  const asc = sortFileEntries(entries, { field: 'size', direction: 'asc' })
  assert.deepEqual(
    asc.map((entry) => entry.name),
    ['alpha-dir', 'Beta', 'alpha.txt', 'file10.txt', 'file2.txt'],
  )
})

test('sortFileEntries sorts by modified time and places missing timestamps last in each group', () => {
  const desc = sortFileEntries(entries, { field: 'modified_at', direction: 'desc' })
  assert.deepEqual(
    desc.map((entry) => entry.name),
    ['alpha-dir', 'Beta', 'file10.txt', 'file2.txt', 'alpha.txt'],
  )

  const asc = sortFileEntries(entries, { field: 'modified_at', direction: 'asc' })
  assert.deepEqual(
    asc.map((entry) => entry.name),
    ['Beta', 'alpha-dir', 'file2.txt', 'file10.txt', 'alpha.txt'],
  )
})

test('sortFileEntries does not mutate the original array and breaks identical-name ties by path', () => {
  const original = [
    { name: 'README.md', path: 'z/README.md', kind: 'file', size: 10, modified_at: null },
    { name: 'README.md', path: 'a/README.md', kind: 'file', size: 10, modified_at: null },
  ]
  const sorted = sortFileEntries(original, { field: 'name', direction: 'asc' })
  assert.deepEqual(sorted.map((entry) => entry.path), ['a/README.md', 'z/README.md'])
  assert.deepEqual(original.map((entry) => entry.path), ['z/README.md', 'a/README.md'])
})
