import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserRound, UsersRound } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import type { Permission, Storage, User } from '../types'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'
import { Input } from './ui/input'
import { RuntimeSettingsSection } from './RuntimeSettingsSection'
import { StorageConnectionsSection } from './StorageConnectionsSection'
import { TrustedAccessSection } from './TrustedAccessSection'

export function AdminPanel({
  storages,
  currentUserId,
  onCurrentUserUpdated,
  onStoragesChanged,
}: {
  storages: Storage[]
  currentUserId: string
  onCurrentUserUpdated: () => Promise<void>
  onStoragesChanged: () => Promise<void>
}) {
  const [users, setUsers] = useState<User[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [userDialog, setUserDialog] = useState(false)
  const [permissionDialog, setPermissionDialog] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)

  async function load() {
    try {
      const [nextUsers, nextPermissions] = await Promise.all([api.users(), api.permissions()])
      setUsers(nextUsers)
      setPermissions(nextPermissions)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to load access settings')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const userNames = useMemo(
    () => new Map(users.map((user) => [user.id, user.username])),
    [users],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-slate-200 bg-white px-5 py-5 sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-400">
              Workspace administration
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
              Configuration &amp; access
            </h1>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setPermissionDialog(true)}>
              <KeyRound className="size-4" />
              Grant access
            </Button>
            <Button onClick={() => setUserDialog(true)}>
              <Plus className="size-4" />
              Add user
            </Button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto overscroll-contain bg-[#f7f8f9] p-5 sm:p-8">
        <div className="mx-auto max-w-6xl space-y-6">
          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
              <span className="grid size-9 place-items-center rounded-lg bg-slate-100 text-slate-600">
                <UsersRound className="size-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-950">Users</h2>
                <p className="text-xs text-slate-400">{users.length} accounts</p>
              </div>
            </div>
            <div>
              {users.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center gap-3 border-b border-slate-100 px-5 py-3.5 last:border-0"
                >
                  <span className="grid size-9 place-items-center rounded-full bg-emerald-50 text-emerald-700">
                    <UserRound className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {user.username}
                      {user.id === currentUserId && (
                        <span className="ml-1.5 text-xs font-normal text-slate-400">You</span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs capitalize text-slate-400">{user.role}</p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-slate-500">
                    {user.is_active ? 'Active' : 'Disabled'}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-slate-400 hover:text-slate-800"
                    onClick={() => setEditingUser(user)}
                  >
                    <Pencil className="size-3.5" />
                    <span className="sr-only">Edit {user.username}</span>
                  </Button>
                </div>
              ))}
            </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
              <span className="grid size-9 place-items-center rounded-lg bg-indigo-50 text-indigo-600">
                <ShieldCheck className="size-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-950">Path permissions</h2>
                <p className="text-xs text-slate-400">The narrowest matching path wins by scope</p>
              </div>
            </div>
            {permissions.length === 0 ? (
              <div className="grid h-48 place-items-center text-center text-sm text-slate-400">
                No explicit permissions yet.
              </div>
            ) : (
              permissions.map((permission) => (
                <div
                  key={permission.id}
                  className="flex items-center gap-3 border-b border-slate-100 px-5 py-3.5 last:border-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-800">
                        {userNames.get(permission.user_id) ?? 'Unknown user'}
                      </span>
                      <span className="font-mono text-[10px] uppercase text-slate-400">
                        {permission.storage_id}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-slate-500">
                      /{permission.path_prefix}
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      {permission.can_read && <AccessBadge>Read</AccessBadge>}
                      {permission.can_write && <AccessBadge>Write</AccessBadge>}
                      {permission.can_manage && <AccessBadge>Manage</AccessBadge>}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-slate-400 hover:text-red-600"
                    onClick={async () => {
                      try {
                        await api.deletePermission(permission.id)
                        await load()
                      } catch (reason) {
                        toast.error(reason instanceof Error ? reason.message : 'Delete failed')
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                    <span className="sr-only">Delete permission</span>
                  </Button>
                </div>
              ))
            )}
            </section>
          </div>
          <StorageConnectionsSection onChanged={onStoragesChanged} />
          <TrustedAccessSection users={users} />
          <RuntimeSettingsSection />
        </div>
      </main>

      <CreateUserDialog
        open={userDialog}
        onOpenChange={setUserDialog}
        onCreated={async () => {
          setUserDialog(false)
          await load()
        }}
      />
      <PermissionDialog
        open={permissionDialog}
        onOpenChange={setPermissionDialog}
        users={users.filter((user) => user.role !== 'admin')}
        storages={storages}
        onCreated={async () => {
          setPermissionDialog(false)
          await load()
        }}
      />
      {editingUser && (
        <EditUserDialog
          user={editingUser}
          open
          onOpenChange={(open) => {
            if (!open) setEditingUser(null)
          }}
          onUpdated={async (updatedUser) => {
            setEditingUser(null)
            await load()
            if (updatedUser.id === currentUserId) await onCurrentUserUpdated()
          }}
        />
      )}
    </div>
  )
}

function EditUserDialog({
  user,
  open,
  onOpenChange,
  onUpdated,
}: {
  user: User
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: (user: User) => Promise<void>
}) {
  const [username, setUsername] = useState(user.username)
  const [password, setPassword] = useState('')
  const [role, setRole] = useState(user.role)
  const [active, setActive] = useState(user.is_active)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setUsername(user.username)
    setPassword('')
    setRole(user.role)
    setActive(user.is_active)
  }, [user])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      const updatedUser = await api.updateUser(user.id, {
        username,
        ...(password ? { password } : {}),
        role,
        is_active: active,
      })
      toast.success(`Updated ${updatedUser.username}`)
      await onUpdated(updatedUser)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to update user')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${user.username}`}
      description="Change the username, reset the password, or update account access."
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Username">
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            minLength={3}
            required
          />
        </Field>
        <Field label="New password">
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Leave unchanged"
          />
        </Field>
        <Field label="Role">
          <select
            className="select-field"
            value={role}
            onChange={(event) => setRole(event.target.value as User['role'])}
          >
            <option value="member">Member</option>
            <option value="admin">Administrator</option>
          </select>
        </Field>
        <label className="flex items-center justify-between rounded-xl bg-slate-50 p-3.5 text-sm text-slate-700">
          <span>
            <span className="block font-medium">Active account</span>
            <span className="mt-0.5 block text-xs text-slate-400">
              Disabled users cannot sign in or use existing sessions.
            </span>
          </span>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !username.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => Promise<void>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('member')

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await api.createUser({ username, password, role })
      toast.success(`Created ${username}`)
      setUsername('')
      setPassword('')
      await onCreated()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to create user')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add a user" description="Create an account, then grant access to one or more storage paths.">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Username">
          <Input value={username} onChange={(event) => setUsername(event.target.value)} required />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <Field label="Role">
          <select className="select-field" value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="member">Member</option>
            <option value="admin">Administrator</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit">Create user</Button>
        </div>
      </form>
    </Dialog>
  )
}

function PermissionDialog({
  open,
  onOpenChange,
  users,
  storages,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  users: User[]
  storages: Storage[]
  onCreated: () => Promise<void>
}) {
  const [userId, setUserId] = useState('')
  const [storageId, setStorageId] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [write, setWrite] = useState(false)
  const [manage, setManage] = useState(false)

  useEffect(() => {
    if (!userId && users[0]) setUserId(users[0].id)
    if (!storageId && storages[0]) setStorageId(storages[0].id)
  }, [users, storages, userId, storageId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await api.grantPermission({
        user_id: userId,
        storage_id: storageId,
        path_prefix: pathPrefix,
        can_read: true,
        can_write: write,
        can_manage: manage,
      })
      toast.success('Permission saved')
      await onCreated()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to save permission')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Grant path access" description="An empty path grants access to the entire storage.">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="User">
          <select className="select-field" value={userId} onChange={(event) => setUserId(event.target.value)} required>
            {users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
          </select>
        </Field>
        <Field label="Storage">
          <select className="select-field" value={storageId} onChange={(event) => setStorageId(event.target.value)} required>
            {storages.map((storage) => <option key={storage.id} value={storage.id}>{storage.name}</option>)}
          </select>
        </Field>
        <Field label="Path prefix">
          <Input value={pathPrefix} onChange={(event) => setPathPrefix(event.target.value)} placeholder="team/documents" />
        </Field>
        <div className="flex gap-5 rounded-xl bg-slate-50 p-3.5 text-sm text-slate-600">
          <label className="flex items-center gap-2"><input type="checkbox" checked readOnly /> Read</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} /> Write</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={manage} onChange={(event) => setManage(event.target.checked)} /> Manage</label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={!userId || !storageId}>Save permission</Button>
        </div>
      </form>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>{children}</label>
}

function AccessBadge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] uppercase text-emerald-700">{children}</span>
}
