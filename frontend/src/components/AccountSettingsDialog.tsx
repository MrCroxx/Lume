import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import type { Session, User } from '../types'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'
import { Input } from './ui/input'

export function AccountSettingsDialog({
  session,
  open,
  onOpenChange,
  onUpdated,
}: {
  session: Session
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: (user: User) => void
}) {
  const [username, setUsername] = useState(session.user.username)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setUsername(session.user.username)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }, [open, session.user.username])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match')
      return
    }
    setSaving(true)
    try {
      const user = await api.updateAccount({
        username,
        current_password: currentPassword,
        ...(newPassword ? { new_password: newPassword } : {}),
      })
      onUpdated(user)
      onOpenChange(false)
      toast.success('Account updated')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to update account')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Account settings"
      description="Update your username or choose a new password. Your current password is always required."
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
        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password">
            <Input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="Leave unchanged"
            />
          </Field>
          <Field label="Confirm password">
            <Input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Repeat new password"
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !currentPassword || !username.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  )
}
