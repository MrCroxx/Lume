import type {
  ArchiveRequest,
  ArchiveTicket,
  BatchDeleteResult,
  FileEntry,
  FileInfo,
  LoginHint,
  LoginOptions,
  Permission,
  RuntimeSettings,
  SaveTrustedAccessRule,
  SaveStorageConnection,
  Session,
  Storage,
  StorageConnection,
  TrustedAccessRule,
  User,
} from '../types'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const BATCH_DELETE_SIZE = 500
const authenticationListeners = new Set<() => void>()

export function onAuthenticationRequired(listener: () => void) {
  authenticationListeners.add(listener)
  return () => { authenticationListeners.delete(listener) }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (typeof init?.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers,
  })
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/login')) {
      // Account updates can reject the current password while the session is valid.
      if (path === '/api/account') {
        await request('/api/auth/session').catch(() => {})
      } else {
        authenticationListeners.forEach((listener) => listener())
      }
    }
    throw new ApiError(await errorMessage(response), response.status)
  }
  return response
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = response.status === 413
    ? 'Upload exceeds the server or reverse proxy size limit (HTTP 413)'
    : `Request failed (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''})`
  const text = (await response.text().catch(() => '')).trim()
  if (!text) return fallback
  try {
    const payload: unknown = JSON.parse(text)
    if (payload && typeof payload === 'object' && 'error' in payload &&
        typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error
    }
  } catch {
    if (response.headers.get('Content-Type')?.startsWith('text/plain') && !text.startsWith('<')) {
      return text.slice(0, 500)
    }
  }
  return fallback
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init)
  const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
    throw new ApiError('Unexpected server response: expected JSON', response.status)
  }
  try {
    return await response.json() as T
  } catch {
    throw new ApiError('Server returned invalid JSON', response.status)
  }
}

async function requestEmpty(path: string, init?: RequestInit): Promise<void> {
  await request(path, init)
}

function withQuery(path: string, values: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value))
  })
  return `${path}?${query}`
}

interface UploadOptions {
  signal: AbortSignal
  onProgress: (loaded: number) => void
  onSent: () => void
}

function uploadWithProgress(url: string, file: File, options: UploadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const cleanup = () => options.signal.removeEventListener('abort', abort)
    const abort = () => xhr.abort()
    xhr.upload.onprogress = (event) => options.onProgress(event.loaded)
    xhr.upload.onload = () => options.onSent()
    xhr.onload = () => {
      cleanup()
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        const response = new Response(xhr.responseText, {
          status: xhr.status || 500,
          statusText: xhr.statusText,
          headers: { 'Content-Type': xhr.getResponseHeader('Content-Type') || '' },
        })
        void errorMessage(response).then((message) => {
          reject(new ApiError(message, xhr.status))
          if (xhr.status === 401) authenticationListeners.forEach((listener) => listener())
        })
      }
    }
    xhr.onerror = () => { cleanup(); reject(new Error('Upload failed: network connection lost')) }
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled', 'AbortError')) }
    xhr.open('PUT', url)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    if (options.signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'))
      return
    }
    options.signal.addEventListener('abort', abort, { once: true })
    try { xhr.send(file) } catch (reason) { cleanup(); reject(reason) }
  })
}

export const api = {
  session: () => requestJson<Session>('/api/auth/session'),
  loginHint: () => requestJson<LoginHint>('/api/auth/login-hint'),
  loginOptions: (username: string) =>
    requestJson<LoginOptions>('/api/auth/login-options', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),
  login: (username: string, password?: string) =>
    requestJson<Session>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => requestEmpty('/api/auth/session', { method: 'DELETE' }),
  updateAccount: (payload: {
    username: string
    current_password: string
    new_password?: string
  }) =>
    requestJson<User>('/api/account', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  storages: () => requestJson<Storage[]>('/api/storages'),
  files: (storageId: string, path: string) =>
    requestJson<FileEntry[]>(withQuery(`/api/files/${storageId}`, { path })),
  fileInfo: (storageId: string, path: string, signal?: AbortSignal) =>
    requestJson<FileInfo>(withQuery(`/api/files/${storageId}/info`, { path }), { signal }),
  search: (storageId: string, path: string, query: string) =>
    requestJson<FileEntry[]>(
      withQuery(`/api/search/${storageId}`, { path, q: query, limit: 200 }),
    ),
  createDirectory: (storageId: string, path: string, signal?: AbortSignal) =>
    requestEmpty(`/api/files/${storageId}/directory`, {
      method: 'POST',
      body: JSON.stringify({ path }),
      signal,
    }),
  upload: (storageId: string, path: string, file: File, options?: UploadOptions) =>
    options ? uploadWithProgress(withQuery(`/api/files/${storageId}`, { path }), file, options) : requestEmpty(withQuery(`/api/files/${storageId}`, { path }), {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    }),
  remove: (storageId: string, entry: FileEntry) =>
    requestEmpty(
      withQuery(`/api/files/${storageId}`, {
        path: entry.path,
        recursive: entry.kind === 'directory',
      }),
      { method: 'DELETE' },
    ),
  removeMany: async (storageId: string, entries: FileEntry[]) => {
    const result: BatchDeleteResult = { deleted: [], failed: [] }
    for (let offset = 0; offset < entries.length; offset += BATCH_DELETE_SIZE) {
      const batch = entries.slice(offset, offset + BATCH_DELETE_SIZE)
      try {
        const batchResult = await requestJson<BatchDeleteResult>(
          `/api/files/${storageId}/batch-delete`,
          {
            method: 'POST',
            body: JSON.stringify({
              entries: batch.map((entry) => ({
                path: entry.path,
                recursive: entry.kind === 'directory',
              })),
            }),
          },
        )
        result.deleted.push(...batchResult.deleted)
        result.failed.push(...batchResult.failed)
      } catch (reason) {
        const error = reason instanceof Error ? reason.message : 'Batch delete failed'
        result.failed.push(
          ...entries.slice(offset).map((entry) => ({ path: entry.path, error })),
        )
        break
      }
    }
    return result
  },
  prepareArchive: (payload: ArchiveRequest) =>
    requestJson<ArchiveTicket>('/api/archives', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  startArchiveDownload: (ticket: ArchiveTicket) => {
    const link = document.createElement('a')
    link.href = ticket.download_url
    link.download = ticket.filename
    document.body.append(link)
    link.click()
    link.remove()
  },
  downloadFile: async (storageId: string, entry: FileEntry) => {
    const url = withQuery(`/api/files/${storageId}/download`, { path: entry.path })
    // Check authorization through the shared handler before starting a browser download.
    await request(url, { method: 'HEAD' })
    const link = document.createElement('a')
    link.href = url
    link.download = entry.name
    document.body.append(link)
    link.click()
    link.remove()
  },
  users: () => requestJson<User[]>('/api/admin/users'),
  createUser: (payload: { username: string; password: string; role: string }) =>
    requestJson<User>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateUser: (
    userId: string,
    payload: { username: string; password?: string; role: string; is_active: boolean },
  ) =>
    requestJson<User>(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  permissions: () => requestJson<Permission[]>('/api/admin/permissions'),
  grantPermission: (payload: Omit<Permission, 'id'>) =>
    requestJson<Permission>('/api/admin/permissions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deletePermission: (id: string) =>
    requestEmpty(`/api/admin/permissions/${id}`, { method: 'DELETE' }),
  trustedAccessRules: () => requestJson<TrustedAccessRule[]>('/api/admin/trusted-access'),
  createTrustedAccessRule: (payload: SaveTrustedAccessRule) =>
    requestJson<TrustedAccessRule>('/api/admin/trusted-access', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateTrustedAccessRule: (id: string, payload: SaveTrustedAccessRule) =>
    requestJson<TrustedAccessRule>(`/api/admin/trusted-access/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteTrustedAccessRule: (id: string) =>
    requestEmpty(`/api/admin/trusted-access/${id}`, { method: 'DELETE' }),
  runtimeSettings: () => requestJson<RuntimeSettings>('/api/admin/settings'),
  updateRuntimeSettings: (payload: RuntimeSettings) =>
    requestJson<RuntimeSettings>('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  storageConnections: () =>
    requestJson<StorageConnection[]>('/api/admin/storage-connections'),
  createStorageConnection: (payload: SaveStorageConnection) =>
    requestJson<StorageConnection>('/api/admin/storage-connections', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateStorageConnection: (id: string, payload: SaveStorageConnection) =>
    requestJson<StorageConnection>(`/api/admin/storage-connections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteStorageConnection: (id: string) =>
    requestEmpty(`/api/admin/storage-connections/${id}`, { method: 'DELETE' }),
}
