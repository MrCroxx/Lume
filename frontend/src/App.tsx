import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  Database,
  FolderKanban,
  HardDrive,
  Layers3,
  LogOut,
  Network,
  Settings2,
  ShieldCheck,
  UserCog,
} from 'lucide-react'
import { Toaster } from 'sonner'
import { AdminPanel } from './components/AdminPanel'
import { AccountSettingsDialog } from './components/AccountSettingsDialog'
import { Brand } from './components/Brand'
import { ConnectionsOverview } from './components/ConnectionsOverview'
import { Explorer } from './components/Explorer'
import { LoginPage } from './components/LoginPage'
import { Button } from './components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu'
import { api, ApiError } from './lib/api'
import {
  initializeBrowserHistory,
  normalizeDirectoryPath,
  pathIsWithin,
  readAppRoute,
  readBrowserHistoryPosition,
  writeAppRoute,
} from './lib/routes'
import type { AppRoute } from './lib/routes'
import { cn } from './lib/utils'
import type { Session, Storage } from './types'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [storages, setStorages] = useState<Storage[]>([])
  const [storagesLoaded, setStoragesLoaded] = useState(false)
  const [route, setRoute] = useState(readAppRoute)
  const [historyPosition, setHistoryPosition] = useState(initializeBrowserHistory)
  const [booting, setBooting] = useState(true)
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false)

  const navigate = useCallback((nextRoute: AppRoute, replace = false) => {
    setHistoryPosition(writeAppRoute(nextRoute, replace))
    setRoute(nextRoute)
  }, [])

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    const handlePopState = () => {
      setRoute(readAppRoute())
      setHistoryPosition(readBrowserHistoryPosition() ?? initializeBrowserHistory())
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (!session || !storagesLoaded) return
    if (route.page === 'admin') {
      if (session.user.role !== 'admin') navigate({ page: 'files', storageId: null, path: '' }, true)
      return
    }
    if (!route.storageId) return

    const storage = storages.find((candidate) => candidate.id === route.storageId)
    if (!storage) {
      navigate({ page: 'files', storageId: null, path: '' }, true)
      return
    }

    const safePath = accessibleStoragePath(storage, route.path)
    if (safePath !== route.path) {
      navigate({ page: 'files', storageId: storage.id, path: safePath }, true)
    }
  }, [navigate, route, session, storages, storagesLoaded])

  async function bootstrap() {
    try {
      const current = await api.session()
      setSession(current)
      await loadStorages()
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.status !== 401) console.error(reason)
    } finally {
      setBooting(false)
    }
  }

  async function loadStorages() {
    setStoragesLoaded(false)
    try {
      setStorages(await api.storages())
    } finally {
      setStoragesLoaded(true)
    }
  }

  async function signOut() {
    await api.logout()
    setSession(null)
  }

  if (booting) return <BootScreen />
  if (!session) {
    return (
      <>
        <LoginPage
          onLogin={(next) => {
            setSession(next)
            void loadStorages()
          }}
        />
        <Toaster richColors position="bottom-right" />
      </>
    )
  }

  const page = route.page
  const selectedStorageId = route.page === 'files' ? route.storageId : null
  const selectedStorage = storages.find((storage) => storage.id === selectedStorageId)
  const selectedPath =
    selectedStorage && route.page === 'files'
      ? accessibleStoragePath(selectedStorage, route.path)
      : ''

  return (
    <div className="flex h-full overflow-hidden bg-[#f7f8f9] text-slate-950">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-800 bg-[#111820] text-white md:flex">
        <div className="flex h-[73px] items-center border-b border-white/5 px-5">
          <div>
            <Brand inverted size="sm" textClassName="text-lg text-white" />
            <p className="mt-1 text-[10px] text-slate-500">Unified file workspace</p>
          </div>
        </div>

        <nav className="p-3">
          <NavButton
            active={page === 'files'}
            onClick={() => navigate({ page: 'files', storageId: null, path: '' })}
          >
            <FolderKanban className="size-4" />
            Files
          </NavButton>
          {session.user.role === 'admin' && (
            <NavButton active={page === 'admin'} onClick={() => navigate({ page: 'admin' })}>
              <ShieldCheck className="size-4" />
              Administration
            </NavButton>
          )}
        </nav>

        <div className="mx-4 border-t border-white/7" />
        <div className="min-h-0 flex-1 overflow-auto px-3 py-5">
          <p className="mb-2 px-2 font-mono text-[9px] uppercase tracking-[0.18em] text-slate-600">
            Storage connections
          </p>
          <div className="space-y-1">
            <button
              onClick={() => {
                navigate({ page: 'files', storageId: null, path: '' })
              }}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                page === 'files' && selectedStorageId === null
                  ? 'bg-white/10 text-white'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
              )}
            >
              <Layers3 className="size-4" />
              <span className="min-w-0 flex-1 truncate">All connections</span>
              <span className="font-mono text-[9px] uppercase text-slate-600">ALL</span>
            </button>
            {storages.map((storage) => {
              const Icon = storageIcon(storage.kind)
              return (
                <button
                  key={storage.id}
                  onClick={() => {
                    navigate({
                      page: 'files',
                      storageId: storage.id,
                      path: storage.roots[0] ?? '',
                    })
                  }}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                    page === 'files' && storage.id === selectedStorageId
                      ? 'bg-white/10 text-white'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                  )}
                >
                  <Icon className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{storage.name}</span>
                  <span className="font-mono text-[9px] uppercase text-slate-600">{storage.kind}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="border-t border-white/5 p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-white/5">
                <span className="grid size-8 place-items-center rounded-full bg-emerald-400 text-xs font-semibold text-slate-950">
                  {session.user.username.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-200">
                    {session.user.username}
                  </span>
                  <span className="block text-[10px] capitalize text-slate-500">
                    {session.auth_method === 'bypass' ? 'Trusted network' : session.user.role}
                  </span>
                </span>
                <ChevronDown className="size-3.5 text-slate-600" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {session.auth_method === 'session' && (
                <DropdownMenuItem onSelect={() => setAccountSettingsOpen(true)}>
                  <UserCog className="size-4" />
                  Account settings
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void signOut()}>
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <MobileHeader
          session={session}
          page={page}
          onFiles={() => navigate({ page: 'files', storageId: null, path: '' })}
          onAdmin={() => navigate({ page: 'admin' })}
          onAccount={() => setAccountSettingsOpen(true)}
          onLogout={signOut}
        />
        {page === 'admin' && session.user.role === 'admin' ? (
          <AdminPanel
            storages={storages}
            currentUserId={session.user.id}
            onCurrentUserUpdated={async () => setSession(await api.session())}
            onStoragesChanged={loadStorages}
          />
        ) : selectedStorage ? (
          <Explorer
            key={selectedStorage.id}
            storage={selectedStorage}
            path={selectedPath}
            canGoBack={historyPosition.index > 0}
            canGoForward={historyPosition.index < historyPosition.maxIndex}
            onBack={() => window.history.back()}
            onForward={() => window.history.forward()}
            onNavigate={(path) =>
              navigate({ page: 'files', storageId: selectedStorage.id, path })
            }
          />
        ) : storages.length > 0 ? (
          <ConnectionsOverview
            storages={storages}
            onOpenStorage={(storageId, path) => {
              navigate({ page: 'files', storageId, path })
            }}
          />
        ) : (
          <NoStorage />
        )}
      </div>
      <AccountSettingsDialog
        session={session}
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
        onUpdated={(user) => setSession({ ...session, user })}
      />
      <Toaster richColors position="bottom-right" />
    </div>
  )
}

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'mb-1 flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors',
        active ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
      )}
    >
      {children}
    </button>
  )
}

function MobileHeader({
  session,
  page,
  onFiles,
  onAdmin,
  onAccount,
  onLogout,
}: {
  session: Session
  page: 'files' | 'admin'
  onFiles: () => void
  onAdmin: () => void
  onAccount: () => void
  onLogout: () => Promise<void>
}) {
  return (
    <div className="flex h-14 items-center gap-2 border-b border-slate-200 bg-white px-4 md:hidden">
      <Brand size="sm" className="mr-auto" textClassName="text-sm" />
      <Button variant={page === 'files' ? 'secondary' : 'ghost'} size="sm" onClick={onFiles}>
        Files
      </Button>
      {session.user.role === 'admin' && (
        <Button variant={page === 'admin' ? 'secondary' : 'ghost'} size="sm" onClick={onAdmin}>
          <Settings2 className="size-3.5" />
        </Button>
      )}
      {session.auth_method === 'session' && (
        <Button variant="ghost" size="icon" className="size-8" onClick={onAccount}>
          <UserCog className="size-4" />
          <span className="sr-only">Account settings</span>
        </Button>
      )}
      <Button variant="ghost" size="icon" className="size-8" onClick={() => void onLogout()}>
        <LogOut className="size-4" />
        <span className="sr-only">Sign out</span>
      </Button>
    </div>
  )
}

function NoStorage() {
  return (
    <main className="grid flex-1 place-items-center p-8 text-center">
      <div>
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
          <Database className="size-5" />
        </span>
        <h1 className="mt-4 text-base font-semibold text-slate-800">No storage is available</h1>
        <p className="mt-1 max-w-sm text-sm leading-6 text-slate-400">
          Ask an administrator to configure a storage connection and grant access.
        </p>
      </div>
    </main>
  )
}

function BootScreen() {
  return (
    <main className="grid h-full place-items-center bg-[#111820] text-white">
      <Brand inverted size="lg" textClassName="text-3xl text-white" />
    </main>
  )
}

function storageIcon(kind: Storage['kind']) {
  if (kind === 'webdav' || kind === 'ftp' || kind === 'sftp') return Network
  if (kind === 's3') return Database
  return HardDrive
}

function accessibleStoragePath(storage: Storage, path: string) {
  const requestedPath = normalizeDirectoryPath(path)
  const roots = storage.roots.map(normalizeDirectoryPath)
  return roots.some((root) => pathIsWithin(requestedPath, root))
    ? requestedPath
    : (roots[0] ?? '')
}

export default App
