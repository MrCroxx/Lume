import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { api, ApiError } from '../src/lib/api.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('upload and directory creation accept empty 201 responses', async () => {
  globalThis.fetch = async () => new Response(null, { status: 201 })
  await api.upload('local', 'empty.txt', new File([], 'empty.txt'))
  await api.createDirectory('local', 'docs/')
})

test('upload sends the original file and content type', async () => {
  const file = new File(['{}'], 'data.json', { type: 'application/json' })
  globalThis.fetch = async (path, init) => {
    assert.equal(new URL(path, 'http://localhost').searchParams.get('path'), 'a & b/data.json')
    assert.equal(init.body, file)
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json')
    return new Response(null, { status: 201 })
  }
  await api.upload('local', 'a & b/data.json', file)
})

test('plain text server errors retain the useful message', async () => {
  globalThis.fetch = async () => new Response('upload body was interrupted', { status: 400 })
  await assert.rejects(api.storages(), (error) =>
    error instanceof ApiError && error.status === 400 && error.message === 'upload body was interrupted')
})

test('proxy HTML errors report status without leaking HTML', async () => {
  globalThis.fetch = async () => new Response('<html>proxy limit</html>', {
    status: 413, headers: { 'Content-Type': 'text/html' },
  })
  await assert.rejects(api.storages(), (error) =>
    error instanceof ApiError && error.status === 413 && /upload|large|limit/i.test(error.message) && !error.message.includes('<html>'))
})

for (const body of ['null', '{"error":{}}', '[]', '']) {
  test(`unexpected error payload ${JSON.stringify(body)} produces an ApiError`, async () => {
    globalThis.fetch = async () => new Response(body, {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
    await assert.rejects(api.storages(), (error) =>
      error instanceof ApiError && error.status === 500 && error.message.length > 0 && !error.message.includes('[object Object]'))
  })
}

test('malformed successful JSON reports an API response error', async () => {
  globalThis.fetch = async () => new Response('{', { headers: { 'Content-Type': 'application/json' } })
  await assert.rejects(api.storages(), (error) =>
    error instanceof ApiError && /invalid JSON/i.test(error.message))
})

test('SPA fallback HTML cannot masquerade as a successful API response', async () => {
  globalThis.fetch = async () => new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } })
  await assert.rejects(api.storages(), (error) =>
    error instanceof ApiError && /expected JSON/i.test(error.message))
})
