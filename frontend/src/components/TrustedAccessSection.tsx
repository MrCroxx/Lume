import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Network, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import type { SaveTrustedAccessRule, TrustedAccessRule, User } from '../types'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'
import { Input } from './ui/input'

export function TrustedAccessSection({ users }: { users: User[] }) {
  const [rules, setRules] = useState<TrustedAccessRule[]>([])
  const [editing, setEditing] = useState<TrustedAccessRule | null | undefined>(undefined)
  const userNames = useMemo(
    () => new Map(users.map((user) => [user.id, user.username])),
    [users],
  )

  async function load() {
    try {
      setRules(await api.trustedAccessRules())
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to load trusted access rules')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
        <span className="grid size-9 place-items-center rounded-lg bg-cyan-50 text-cyan-700">
          <Network className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-950">Trusted access</h2>
          <p className="text-xs text-slate-400">
            Network rules authenticate a selected user; normal role and path permissions still apply.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setEditing(null)} disabled={users.length === 0}>
          <Plus className="size-4" />
          Add rule
        </Button>
      </div>
      {rules.length === 0 ? (
        <div className="grid h-32 place-items-center text-sm text-slate-400">
          No trusted access rules configured.
        </div>
      ) : (
        rules.map((rule) => (
          <div
            key={rule.id}
            className="flex items-center gap-4 border-b border-slate-100 px-5 py-4 last:border-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-800">{rule.name}</span>
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                  {userNames.get(rule.user_id) ?? 'Unknown user'}
                </span>
                <span
                  className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                    rule.enabled
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {rule.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p className="mt-1 break-all font-mono text-xs text-slate-400">
                {[
                  rule.cidrs.length > 0 ? `CIDR: ${rule.cidrs.join(', ')}` : '',
                  rule.domains.length > 0 ? `Domain: ${rule.domains.join(', ')}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setEditing(rule)}>
              <Pencil className="size-4" />
              <span className="sr-only">Edit rule</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-slate-400 hover:text-red-600"
              onClick={async () => {
                try {
                  await api.deleteTrustedAccessRule(rule.id)
                  await load()
                } catch (reason) {
                  toast.error(reason instanceof Error ? reason.message : 'Unable to delete rule')
                }
              }}
            >
              <Trash2 className="size-4" />
              <span className="sr-only">Delete rule</span>
            </Button>
          </div>
        ))
      )}
      {editing !== undefined && (
        <TrustedAccessDialog
          rule={editing}
          users={users}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined)
            await load()
          }}
        />
      )}
    </section>
  )
}

function TrustedAccessDialog({
  rule,
  users,
  onClose,
  onSaved,
}: {
  rule: TrustedAccessRule | null
  users: User[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [userId, setUserId] = useState(rule?.user_id ?? users[0]?.id ?? '')
  const [name, setName] = useState(rule?.name ?? '')
  const [cidrs, setCidrs] = useState(rule?.cidrs.join('\n') ?? '')
  const [domains, setDomains] = useState(rule?.domains.join('\n') ?? '')
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    const payload: SaveTrustedAccessRule = {
      user_id: userId,
      name,
      enabled,
      cidrs: splitValues(cidrs),
      domains: splitValues(domains),
    }
    try {
      if (rule) await api.updateTrustedAccessRule(rule.id, payload)
      else await api.createTrustedAccessRule(payload)
      toast.success(rule ? 'Trusted access rule updated' : 'Trusted access rule created')
      await onSaved()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to save rule')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={rule ? 'Edit trusted access' : 'Add trusted access'}
      description="CIDRs and domains in one rule must both match. Add separate rules for OR behavior."
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label="User">
          <select
            className="select-field"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            required
          >
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.username}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rule name">
          <Input value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Client CIDRs">
          <textarea
            className="text-area"
            rows={3}
            value={cidrs}
            onChange={(event) => setCidrs(event.target.value)}
            placeholder={'192.0.2.0/24\n2001:db8::42/128'}
          />
        </Field>
        <Field label="Access domains">
          <textarea
            className="text-area"
            rows={3}
            value={domains}
            onChange={(event) => setDomains(event.target.value)}
            placeholder={'files.home.arpa\n*.files.home.arpa'}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !userId || !name.trim()}>
            {saving ? 'Saving…' : 'Save rule'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function splitValues(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  )
}
