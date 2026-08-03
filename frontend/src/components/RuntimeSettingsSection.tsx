import { useEffect, useState, type FormEvent } from 'react'
import { Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import type { RuntimeSettings } from '../types'
import { Button } from './ui/button'
import { Input } from './ui/input'

export function RuntimeSettingsSection() {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null)
  const [proxyCidrs, setProxyCidrs] = useState('')
  const [uploadMegabytes, setUploadMegabytes] = useState(256)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void api
      .runtimeSettings()
      .then((value) => {
        setSettings(value)
        setProxyCidrs(value.trusted_proxy_cidrs.join('\n'))
        setUploadMegabytes(Math.max(1, Math.round(value.max_upload_bytes / 1024 / 1024)))
      })
      .catch((reason) =>
        toast.error(reason instanceof Error ? reason.message : 'Unable to load settings'),
      )
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!settings) return
    setSaving(true)
    try {
      const updated = await api.updateRuntimeSettings({
        ...settings,
        max_upload_bytes: uploadMegabytes * 1024 * 1024,
        trusted_proxy_cidrs: splitValues(proxyCidrs),
      })
      setSettings(updated)
      setProxyCidrs(updated.trusted_proxy_cidrs.join('\n'))
      toast.success('Runtime settings updated')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to update settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
        <span className="grid size-9 place-items-center rounded-lg bg-violet-50 text-violet-700">
          <Settings2 className="size-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-slate-950">Runtime settings</h2>
          <p className="text-xs text-slate-400">Saved in SQLite and applied without a restart.</p>
        </div>
      </div>
      {settings && (
        <form className="grid gap-5 p-5 md:grid-cols-2" onSubmit={submit}>
          <Field label="Session duration (hours)">
            <Input
              type="number"
              min={1}
              value={settings.session_hours}
              onChange={(event) =>
                setSettings({ ...settings, session_hours: Number(event.target.value) })
              }
              required
            />
          </Field>
          <Field label="Maximum upload (MiB)">
            <Input
              type="number"
              min={1}
              value={uploadMegabytes}
              onChange={(event) => setUploadMegabytes(Number(event.target.value))}
              required
            />
          </Field>
          <Field label="Trusted proxy CIDRs">
            <textarea
              className="text-area"
              rows={4}
              value={proxyCidrs}
              onChange={(event) => setProxyCidrs(event.target.value)}
              placeholder={'172.18.0.0/16\nfd00::/8'}
            />
          </Field>
          <div className="flex flex-col justify-between gap-5">
            <label className="flex items-start gap-3 rounded-xl bg-slate-50 p-3.5 text-sm text-slate-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={settings.secure_cookies}
                onChange={(event) =>
                  setSettings({ ...settings, secure_cookies: event.target.checked })
                }
              />
              <span>
                <span className="block font-medium">Secure cookies</span>
                <span className="mt-0.5 block text-xs leading-5 text-slate-400">
                  Enable only when Lume is served over HTTPS.
                </span>
              </span>
            </label>
            <Button className="self-end" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </form>
      )}
    </section>
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
