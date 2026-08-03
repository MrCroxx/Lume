import { useEffect, useState, type FormEvent } from 'react'
import { Database, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import type { SaveStorageConnection, Storage, StorageConnection } from '../types'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'
import { Input } from './ui/input'

export function StorageConnectionsSection({ onChanged }: { onChanged: () => Promise<void> }) {
  const [connections, setConnections] = useState<StorageConnection[]>([])
  const [editing, setEditing] = useState<StorageConnection | null | undefined>(undefined)

  async function load() {
    try {
      setConnections(await api.storageConnections())
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to load storage connections')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
        <span className="grid size-9 place-items-center rounded-lg bg-amber-50 text-amber-700">
          <Database className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-950">Storage connections</h2>
          <p className="text-xs text-slate-400">
            OpenDAL connections are encrypted in SQLite and reloaded without restarting Lume.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setEditing(null)}>
          <Plus className="size-4" />
          Add storage
        </Button>
      </div>
      {connections.length === 0 ? (
        <div className="grid h-32 place-items-center text-sm text-slate-400">
          No storage connections configured.
        </div>
      ) : (
        connections.map((connection) => (
          <div
            key={connection.id}
            className="flex items-center gap-4 border-b border-slate-100 px-5 py-4 last:border-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-800">{connection.name}</span>
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-500">
                  {connection.kind}
                </span>
                <span
                  className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                    connection.enabled
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {connection.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p className="mt-1 break-all font-mono text-xs text-slate-400">
                {connection.id} · {connectionLocation(connection)}
              </p>
              {connection.last_error && (
                <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
                  {connection.last_error}
                </p>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={() => setEditing(connection)}>
              <Pencil className="size-4" />
              <span className="sr-only">Edit storage</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-slate-400 hover:text-red-600"
              onClick={async () => {
                if (!window.confirm(`Delete ${connection.name} and its path permissions?`)) return
                try {
                  await api.deleteStorageConnection(connection.id)
                  await Promise.all([load(), onChanged()])
                } catch (reason) {
                  toast.error(reason instanceof Error ? reason.message : 'Unable to delete storage')
                }
              }}
            >
              <Trash2 className="size-4" />
              <span className="sr-only">Delete storage</span>
            </Button>
          </div>
        ))
      )}
      {editing !== undefined && (
        <StorageConnectionDialog
          connection={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined)
            await Promise.all([load(), onChanged()])
          }}
        />
      )}
    </section>
  )
}

function StorageConnectionDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: StorageConnection | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [id, setId] = useState(connection?.id ?? '')
  const [name, setName] = useState(connection?.name ?? '')
  const [kind, setKind] = useState<Storage['kind']>(connection?.kind ?? 'fs')
  const [enabled, setEnabled] = useState(connection?.enabled ?? true)
  const [root, setRoot] = useState(connection?.root ?? '')
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? '')
  const [mountPath, setMountPath] = useState(connection?.mount_path ?? '')
  const [username, setUsername] = useState(connection?.username ?? '')
  const [password, setPassword] = useState('')
  const [key, setKey] = useState('')
  const [bucket, setBucket] = useState(connection?.bucket ?? '')
  const [region, setRegion] = useState(connection?.region ?? '')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [knownHostsStrategy, setKnownHostsStrategy] = useState(
    connection?.known_hosts_strategy ?? 'Strict',
  )
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    const payload: SaveStorageConnection = {
      id,
      name,
      kind,
      enabled,
      root,
      endpoint,
      mount_path: mountPath,
      username,
      password: password || undefined,
      key: key || undefined,
      bucket,
      region,
      access_key_id: accessKeyId || undefined,
      secret_access_key: secretAccessKey || undefined,
      known_hosts_strategy: knownHostsStrategy,
    }
    try {
      if (connection) await api.updateStorageConnection(connection.id, payload)
      else await api.createStorageConnection(payload)
      toast.success(connection ? 'Storage connection updated' : 'Storage connection created')
      await onSaved()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to save storage')
    } finally {
      setSaving(false)
    }
  }

  const remote = ['ftp', 'sftp', 'webdav'].includes(kind)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={connection ? 'Edit storage connection' : 'Add storage connection'}
      description="Credentials are encrypted before they are written to SQLite."
    >
      <form className="max-h-[70vh] space-y-4 overflow-auto pr-1" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Storage ID">
            <Input
              value={id}
              onChange={(event) => setId(event.target.value)}
              disabled={Boolean(connection)}
              required
            />
          </Field>
          <Field label="Display name">
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
        </div>
        <Field label="Backend kind">
          <select
            className="select-field"
            value={kind}
            onChange={(event) => setKind(event.target.value as Storage['kind'])}
          >
            <option value="fs">Local filesystem</option>
            <option value="smb">Samba mount</option>
            <option value="webdav">WebDAV</option>
            <option value="ftp">FTP</option>
            <option value="sftp">SFTP</option>
            <option value="s3">S3</option>
          </select>
        </Field>

        {kind === 'fs' && (
          <Field label="Filesystem root">
            <Input value={root} onChange={(event) => setRoot(event.target.value)} required />
          </Field>
        )}
        {kind === 'smb' && (
          <Field label="Mounted directory">
            <Input
              value={mountPath}
              onChange={(event) => setMountPath(event.target.value)}
              placeholder="/mnt/team-share"
              required
            />
          </Field>
        )}
        {remote && (
          <>
            <Field label="Endpoint">
              <Input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder={endpointPlaceholder(kind)}
                required
              />
            </Field>
            <Field label="Remote root">
              <Input value={root} onChange={(event) => setRoot(event.target.value)} />
            </Field>
            <Field label={kind === 'webdav' ? 'Username' : 'User'}>
              <Input value={username} onChange={(event) => setUsername(event.target.value)} />
            </Field>
          </>
        )}
        {(kind === 'ftp' || kind === 'webdav') && (
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={connection?.has_password ? 'Leave unchanged' : 'Optional'}
            />
          </Field>
        )}
        {kind === 'sftp' && (
          <>
            <Field label="Private key">
              <textarea
                className="text-area font-mono"
                rows={5}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={connection?.has_key ? 'Leave unchanged' : 'Optional private key'}
              />
            </Field>
            <Field label="Known hosts strategy">
              <Input
                value={knownHostsStrategy}
                onChange={(event) => setKnownHostsStrategy(event.target.value)}
              />
            </Field>
          </>
        )}
        {kind === 's3' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Bucket">
                <Input value={bucket} onChange={(event) => setBucket(event.target.value)} required />
              </Field>
              <Field label="Region">
                <Input value={region} onChange={(event) => setRegion(event.target.value)} />
              </Field>
            </div>
            <Field label="Endpoint">
              <Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
            </Field>
            <Field label="Object root">
              <Input value={root} onChange={(event) => setRoot(event.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Access key ID">
                <Input
                  type="password"
                  value={accessKeyId}
                  onChange={(event) => setAccessKeyId(event.target.value)}
                  placeholder={connection?.has_access_key_id ? 'Leave unchanged' : 'Optional'}
                />
              </Field>
              <Field label="Secret access key">
                <Input
                  type="password"
                  value={secretAccessKey}
                  onChange={(event) => setSecretAccessKey(event.target.value)}
                  placeholder={connection?.has_secret_access_key ? 'Leave unchanged' : 'Optional'}
                />
              </Field>
            </div>
          </>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !id.trim() || !name.trim()}>
            {saving ? 'Saving…' : 'Save storage'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function connectionLocation(connection: StorageConnection) {
  if (connection.kind === 'fs') return connection.root
  if (connection.kind === 'smb') return connection.mount_path ?? ''
  if (connection.kind === 's3') return connection.endpoint || connection.bucket || ''
  return connection.endpoint ?? ''
}

function endpointPlaceholder(kind: Storage['kind']) {
  if (kind === 'webdav') return 'https://dav.example.com'
  if (kind === 'sftp') return 'ssh://host.example.com:22'
  return 'ftp://host.example.com:21'
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  )
}
