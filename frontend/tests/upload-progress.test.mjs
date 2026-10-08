import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { api, ApiError, onAuthenticationRequired } from '../src/lib/api.ts'

const original = globalThis.XMLHttpRequest
let request
class MockXHR {
  upload = {}
  status = 201
  statusText = ''
  responseText = ''
  constructor() { request = this }
  open(method, url) { this.method = method; this.url = url }
  setRequestHeader(name, value) { this.header = [name, value] }
  getResponseHeader() { return 'text/html' }
  send(body) { this.body = body }
  abort() { this.onabort() }
}
afterEach(() => { globalThis.XMLHttpRequest = original })
function upload(options = {}) {
  globalThis.XMLHttpRequest = MockXHR
  const controller = new AbortController()
  const file = new File(['hello'], 'test.txt', { type: 'text/plain' })
  const promise = api.upload('local', 'Folder/a & B.txt', file, {
    signal: controller.signal, onProgress: () => {}, onSent: () => {}, ...options,
  })
  return { promise, controller, file }
}

test('progress uses raw file bytes and waits for server completion', async () => {
  let loaded = 0
  let sent = false
  let resolved = false
  const { promise, file } = upload({ onProgress: (value) => { loaded = value }, onSent: () => { sent = true } })
  promise.then(() => { resolved = true })
  assert.equal(request.method, 'PUT')
  assert.equal(new URL(request.url, 'http://localhost').searchParams.get('path'), 'Folder/a & B.txt')
  assert.equal(request.withCredentials, true)
  assert.equal(request.body, file)
  request.upload.onprogress({ loaded: 3 })
  assert.equal(loaded, 3)
  request.upload.onload()
  await Promise.resolve()
  assert.equal(sent, true)
  assert.equal(resolved, false)
  request.onload()
  await promise
})

test('proxy size errors keep useful HTTP status without HTML', async () => {
  const { promise } = upload()
  request.status = 413
  request.responseText = '<html>too large</html>'
  request.onload()
  await assert.rejects(promise, (error) => error instanceof ApiError && error.status === 413 && !error.message.includes('<html>'))
})

test('progress uploads notify authentication listeners on 401', async () => {
  let notifications = 0
  const unsubscribe = onAuthenticationRequired(() => { notifications += 1 })
  try {
    const { promise } = upload()
    request.status = 401
    request.onload()
    await assert.rejects(promise, (error) => error.status === 401)
    assert.equal(notifications, 1)
  } finally { unsubscribe() }
})

test('abort and network errors reject the upload', async () => {
  const first = upload()
  first.controller.abort()
  await assert.rejects(first.promise, (error) => error.name === 'AbortError')
  const second = upload()
  request.onerror()
  await assert.rejects(second.promise, /network/)
})
