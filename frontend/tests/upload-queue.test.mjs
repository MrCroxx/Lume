import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UploadQueue } from '../src/lib/upload-queue.ts'

const file = (path) => ({ kind: 'file', path, file: new File(['12345678'], path) })
const tick = () => new Promise((resolve) => setImmediate(resolve))
function harness() {
  const calls = []
  const transport = {
    file: (storageId, path, file, options) => new Promise((resolve, reject) => {
      calls.push({ storageId, path, file, options, resolve, reject })
      options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))
    }),
    directory: (storageId, path, signal) => transport.file(storageId, path, null, { signal }),
  }
  return { queue: new UploadQueue(transport), calls }
}

test('large batches cap concurrency at three and preserve each destination', async () => {
  const { queue, calls } = harness()
  await queue.add('one', 'One', 'Docs/', Promise.resolve(Array.from({ length: 1000 }, (_, i) => file(`${i}.txt`))))
  assert.equal(calls.length, 3)
  assert.equal(queue.getSnapshot().tasks.length, 1000)
  calls[0].resolve()
  await tick()
  assert.equal(calls.length, 4)
  await queue.add('two', 'Two', 'Other/', Promise.resolve([file('extra.txt')]))
  assert.equal(queue.getSnapshot().tasks.at(-1).path, 'Other/extra.txt')
  assert.equal(queue.getSnapshot().tasks.at(-1).storageId, 'two')
  queue.cancelAll()
  await tick()
  assert.equal(calls.length, 4)
})

test('bytes sent is distinct from server-confirmed completion', async () => {
  const { queue, calls } = harness()
  await queue.add('one', 'One', '', Promise.resolve([file('a')]))
  calls[0].options.onProgress(4)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(queue.getSnapshot().tasks[0].loaded, 4)
  assert.equal(queue.getSnapshot().tasks[0].status, 'uploading')
  calls[0].options.onSent()
  assert.equal(queue.getSnapshot().tasks[0].loaded, 8)
  assert.equal(queue.getSnapshot().tasks[0].status, 'saving')
  calls[0].resolve()
  await tick()
  assert.equal(queue.getSnapshot().tasks[0].status, 'complete')
  assert.equal(queue.getSnapshot().revision, 1)
})

test('directory failures block descendants, independent files continue, retry recreates parents first', async () => {
  const { queue, calls } = harness()
  await queue.add('one', 'One', '', Promise.resolve([
    { kind: 'directory', path: 'folder/' }, file('folder/a'), file('other'),
  ]))
  assert.deepEqual(calls.map((call) => call.path), ['folder/', 'other'])
  calls[0].reject(new Error('Permission denied'))
  calls[1].resolve()
  await tick()
  assert.deepEqual(queue.getSnapshot().tasks.map((task) => task.status), ['failed', 'failed', 'complete'])
  queue.clearFinished()
  queue.retryFailed()
  assert.equal(calls[2].path, 'folder/')
  calls[2].resolve()
  await tick()
  assert.equal(calls[3].path, 'folder/a')
  calls[3].resolve()
  await tick()
  assert.ok(queue.getSnapshot().tasks.every((task) => task.status === 'complete'))
})

test('duplicate destinations are serialized even when an earlier failed task is retried', async () => {
  const { queue, calls } = harness()
  await queue.add('one', 'One', '', Promise.resolve([file('same'), file('same')]))
  assert.equal(calls.length, 1)
  calls[0].reject(new Error('Temporary error'))
  await tick()
  assert.equal(calls.length, 2)
  queue.retryFailed()
  assert.equal(calls.length, 2)
  calls[1].resolve()
  await tick()
  assert.equal(calls.length, 3)
  calls[2].resolve()
  await tick()
  assert.ok(queue.getSnapshot().tasks.every((task) => task.status === 'complete'))
})

test('cancellation discards pending folder reads and late success does not revive cancelled uploads', async () => {
  const { queue, calls } = harness()
  let release
  const adding = queue.add('one', 'One', '', new Promise((resolve) => { release = resolve }))
  queue.cancelAll()
  release([file('late')])
  await adding
  assert.equal(calls.length, 0)
  assert.equal(queue.getSnapshot().preparing, 0)
  await queue.add('one', 'One', '', Promise.resolve([file('a')]))
  queue.cancelAll()
  calls[0].options.onSent()
  calls[0].resolve()
  await tick()
  assert.equal(queue.getSnapshot().tasks[0].status, 'cancelled')
  assert.equal(queue.getSnapshot().revision, 0)
})
