export interface User {
  id: string
  username: string
  role: 'admin' | 'member'
  is_active: boolean
  created_at: string
}

export interface Session {
  user: User
  auth_method: 'session' | 'bypass'
}

export interface LoginOptions {
  password_required: boolean
}

export interface Storage {
  id: string
  name: string
  kind: 'fs' | 'smb' | 'ftp' | 'sftp' | 'webdav' | 's3'
  can_read: boolean
  can_write: boolean
  can_manage: boolean
  roots: string[]
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number
  modified_at: string | null
}

export interface BatchDeleteResult {
  deleted: string[]
  failed: Array<{
    path: string
    error: string
  }>
}

export interface ArchiveEntry {
  storage_id: string
  path: string
  kind: FileEntry['kind']
}

export interface ArchiveRequest {
  base_path?: string
  entries: ArchiveEntry[]
}

export interface ArchiveTicket {
  download_url: string
  filename: string
}

export interface Permission {
  id: string
  user_id: string
  storage_id: string
  path_prefix: string
  can_read: boolean
  can_write: boolean
  can_manage: boolean
}

export interface TrustedAccessRule {
  id: string
  user_id: string
  name: string
  enabled: boolean
  cidrs: string[]
  domains: string[]
  created_at: string
  updated_at: string
}

export type SaveTrustedAccessRule = Pick<
  TrustedAccessRule,
  'user_id' | 'name' | 'enabled' | 'cidrs' | 'domains'
>

export interface RuntimeSettings {
  session_hours: number
  secure_cookies: boolean
  max_upload_bytes: number
  trusted_proxy_cidrs: string[]
}

export interface StorageConnection {
  id: string
  name: string
  kind: Storage['kind']
  enabled: boolean
  root: string
  endpoint: string | null
  mount_path: string | null
  username: string | null
  bucket: string | null
  region: string | null
  known_hosts_strategy: string | null
  has_password: boolean
  has_key: boolean
  has_access_key_id: boolean
  has_secret_access_key: boolean
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface SaveStorageConnection {
  id: string
  name: string
  kind: Storage['kind']
  enabled: boolean
  root: string
  endpoint?: string
  mount_path?: string
  username?: string
  password?: string
  key?: string
  bucket?: string
  region?: string
  access_key_id?: string
  secret_access_key?: string
  known_hosts_strategy?: string
}
