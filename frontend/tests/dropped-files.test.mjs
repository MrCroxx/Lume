import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isFileDrag, readDroppedItems } from '../src/lib/dropped-files.ts'

function fileEntry(name) {
  const value = new File([name], name)
  return { name, isFile: true, isDirectory: false, file: (resolve) => resolve(value) }
}

function directory(name, batches) {
  return {
    name, isFile: false, isDirectory: true,
    createReader() {
      let index = 0
      return { readEntries: (resolve) => resolve(batches[index++] ?? []) }
    },
  }
}

function transfer(entries) {
  return {
    types: ['Files'], files: [],
    items: entries.map((entry) => ({
      kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null,
    })),
  }
}

test('file drags exclude links and text', () => {
  assert.equal(isFileDrag(null), false)
  assert.equal(isFileDrag({ types: ['text/plain', 'text/uri-list'] }), false)
  assert.equal(isFileDrag({ types: ['Files', 'text/plain'] }), true)
})

test('mixed drops preserve nested paths, empty folders, and all directory batches', async () => {
  const items = await readDroppedItems(transfer([
    fileEntry('top.txt'),
    directory('folder', [
      [fileEntry('first.txt'), directory('empty', [])],
      [directory('nested', [[fileEntry('last.txt')]])],
    ]),
  ]))
  assert.deepEqual(items.map(({ kind, path }) => [kind, path]), [
    ['file', 'top.txt'], ['directory', 'folder/'], ['file', 'folder/first.txt'],
    ['directory', 'folder/empty/'], ['directory', 'folder/nested/'],
    ['file', 'folder/nested/last.txt'],
  ])
  assert.equal(await items.at(-1).file.text(), 'last.txt')
})

test('drop data is captured synchronously before asynchronous traversal', async () => {
  let release
  const data = transfer([
    { ...fileEntry('slow.txt'), file: (resolve) => { release = resolve } },
    fileEntry('second.txt'),
  ])
  const result = readDroppedItems(data)
  data.items.forEach((item) => {
    item.webkitGetAsEntry = () => { throw new Error('Data store is protected') }
    item.getAsFile = () => null
  })
  data.items = []
  release(new File([], 'slow.txt'))
  assert.deepEqual((await result).map((item) => item.path), ['slow.txt', 'second.txt'])
})

test('plain files work without the entry API or data transfer items', async () => {
  const file = new File([], 'a & b.txt')
  for (const data of [
    { files: [file], items: [] },
    { files: [file], items: [{ kind: 'file', getAsFile: () => file }] },
  ]) {
    assert.deepEqual(await readDroppedItems(data), [{ kind: 'file', path: file.name, file }])
  }
})

test('directory read failures reject the whole preparation instead of skipping contents', async () => {
  const entry = directory('unreadable', [])
  entry.createReader = () => ({ readEntries: (_, reject) => reject(new Error('Access denied')) })
  await assert.rejects(readDroppedItems(transfer([entry])), /Access denied/)
})

test('unreadable dropped items surface an error', async () => {
  await assert.rejects(readDroppedItems(transfer([null])), /Unable to read/)
})
