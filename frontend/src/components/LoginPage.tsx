import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, CheckCircle2, LockKeyhole } from 'lucide-react'
import { api } from '../lib/api'
import type { Session } from '../types'
import { Brand } from './Brand'
import { Button } from './ui/button'
import { Input } from './ui/input'

export function LoginPage({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checkingOptions, setCheckingOptions] = useState(false)
  const [passwordRequired, setPasswordRequired] = useState(true)

  useEffect(() => {
    const candidate = username.trim()
    setPasswordRequired(true)
    if (!candidate) {
      setCheckingOptions(false)
      return
    }
    setCheckingOptions(true)
    let cancelled = false
    const timer = window.setTimeout(() => {
      void api
        .loginOptions(candidate)
        .then((options) => {
          if (cancelled) return
          setPasswordRequired(options.password_required)
          if (!options.password_required) setPassword('')
        })
        .catch(() => {
          if (!cancelled) setPasswordRequired(true)
        })
        .finally(() => {
          if (!cancelled) setCheckingOptions(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [username])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      onLogin(await api.login(username, passwordRequired ? password : undefined))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="grid h-full overflow-auto overscroll-contain bg-[#f4f5f6] lg:grid-cols-[1.05fr_0.95fr]">
      <section className="relative hidden overflow-hidden bg-[#111820] p-14 text-white lg:flex lg:flex-col">
        <div className="absolute inset-0 login-grid opacity-30" />
        <Brand
          inverted
          size="lg"
          className="relative"
          textClassName="text-3xl text-white"
        />
        <div className="relative my-auto max-w-xl">
          <p className="mb-6 font-mono text-xs uppercase tracking-[0.24em] text-emerald-300">
            One place for every storage
          </p>
          <h1 className="text-5xl font-semibold leading-[1.08] tracking-[-0.045em]">
            Your files, without the storage silos.
          </h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-slate-400">
            Browse local disks, WebDAV, FTP, Samba, and object storage through one secure,
            thoughtfully simple workspace.
          </p>
        </div>
        <div className="relative flex items-center gap-2 text-xs text-slate-500">
          <LockKeyhole className="size-3.5" />
          Access is scoped to your account and path permissions.
        </div>
      </section>

      <section className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          <Brand size="md" className="mb-10 lg:hidden" textClassName="text-2xl" />
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-slate-400">Welcome back</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] text-slate-950">
            Sign in to your workspace
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Use the account provided by your administrator.
          </p>
          <form className="mt-8 space-y-5" onSubmit={submit}>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Username</span>
              <Input
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => {
                  setPasswordRequired(true)
                  setUsername(event.target.value)
                }}
                placeholder="you@example.com"
                required
              />
            </label>
            {passwordRequired ? (
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-slate-700">Password</span>
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  required
                />
              </label>
            ) : (
              <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3.5 py-3 text-sm text-emerald-700">
                <CheckCircle2 className="size-4 shrink-0" />
                Trusted access is available for this account.
              </div>
            )}
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Button className="h-11 w-full" disabled={loading || checkingOptions}>
              {loading ? 'Signing in…' : checkingOptions ? 'Checking access…' : 'Continue'}
              {!loading && <ArrowRight className="size-4" />}
            </Button>
          </form>
        </div>
      </section>
    </main>
  )
}
