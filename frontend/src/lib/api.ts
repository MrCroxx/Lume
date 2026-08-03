import type {
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function withQuery(path: string, values: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value))
  })
  return `${path}?${query}`
}

export const api = {
  session: () => request<Session>('/api/auth/session'),
  loginOptions: (username: string) =>
    request<LoginOptions>('/api/auth/login-options', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),
  login: (username: string, password?: string) =>
    request<Session>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>('/api/auth/session', { method: 'DELETE' }),
  updateAccount: (payload: {
    username: string
    current_password: string
    new_password?: string
  }) =>
    request<User>('/api/account', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  storages: () => request<Storage[]>('/api/storages'),
  files: (storageId: string, path: string) =>
    request<FileEntry[]>(withQuery(`/api/files/${storageId}`, { path })),
  search: (storageId: string, path: string, query: string) =>
    request<FileEntry[]>(
      withQuery(`/api/search/${storageId}`, { path, q: query, limit: 200 }),
    ),
  createDirectory: (storageId: string, path: string) =>
    request<void>(`/api/files/${storageId}/directory`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  upload: (storageId: string, path: string, file: File) =>
    request<void>(withQuery(`/api/files/${storageId}`, { path }), {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    }),
  remove: (storageId: string, entry: FileEntry) =>
    request<void>(
      withQuery(`/api/files/${storageId}`, {
        path: entry.path,
        recursive: entry.kind === 'directory',
      }),
      { method: 'DELETE' },
    ),
  downloadUrl: (storageId: string, path: string) =>
    withQuery(`/api/files/${storageId}/download`, { path }),
  users: () => request<User[]>('/api/admin/users'),
  createUser: (payload: { username: string; password: string; role: string }) =>
    request<User>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateUser: (
    userId: string,
    payload: { username: string; password?: string; role: string; is_active: boolean },
  ) =>
    request<User>(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  permissions: () => request<Permission[]>('/api/admin/permissions'),
  grantPermission: (payload: Omit<Permission, 'id'>) =>
    request<Permission>('/api/admin/permissions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deletePermission: (id: string) =>
    request<void>(`/api/admin/permissions/${id}`, { method: 'DELETE' }),
  trustedAccessRules: () => request<TrustedAccessRule[]>('/api/admin/trusted-access'),
  createTrustedAccessRule: (payload: SaveTrustedAccessRule) =>
    request<TrustedAccessRule>('/api/admin/trusted-access', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateTrustedAccessRule: (id: string, payload: SaveTrustedAccessRule) =>
    request<TrustedAccessRule>(`/api/admin/trusted-access/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteTrustedAccessRule: (id: string) =>
    request<void>(`/api/admin/trusted-access/${id}`, { method: 'DELETE' }),
  runtimeSettings: () => request<RuntimeSettings>('/api/admin/settings'),
  updateRuntimeSettings: (payload: RuntimeSettings) =>
    request<RuntimeSettings>('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  storageConnections: () =>
    request<StorageConnection[]>('/api/admin/storage-connections'),
  createStorageConnection: (payload: SaveStorageConnection) =>
    request<StorageConnection>('/api/admin/storage-connections', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateStorageConnection: (id: string, payload: SaveStorageConnection) =>
    request<StorageConnection>(`/api/admin/storage-connections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteStorageConnection: (id: string) =>
    request<void>(`/api/admin/storage-connections/${id}`, { method: 'DELETE' }),
}
