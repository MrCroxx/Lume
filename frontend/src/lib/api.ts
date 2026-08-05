import type {
  ArchiveRequest,
  ArchiveTicket,
  BatchDeleteResult,
  FileEntry,
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
    this.status = status
  }
}

const BATCH_DELETE_SIZE = 500

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof File) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }))
    throw new ApiError(payload.error ?? response.statusText, response.status)
  }
  return response
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init)
  return response.json() as Promise<T>
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

export const api = {
  session: () => requestJson<Session>('/api/auth/session'),
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
  search: (storageId: string, path: string, query: string) =>
    requestJson<FileEntry[]>(
      withQuery(`/api/search/${storageId}`, { path, q: query, limit: 200 }),
    ),
  createDirectory: (storageId: string, path: string) =>
    requestEmpty(`/api/files/${storageId}/directory`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  upload: (storageId: string, path: string, file: File) =>
    requestEmpty(withQuery(`/api/files/${storageId}`, { path }), {
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
  downloadUrl: (storageId: string, path: string) =>
    withQuery(`/api/files/${storageId}/download`, { path }),
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
