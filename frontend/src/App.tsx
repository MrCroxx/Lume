import { useCallback, useEffect, useState } from 'react'
import { Database, Menu } from 'lucide-react'
import { Toaster } from 'sonner'
import { AdminPanel } from './components/AdminPanel'
import { AccountSettingsDialog } from './components/AccountSettingsDialog'
import { Brand } from './components/Brand'
import { ConnectionsOverview } from './components/ConnectionsOverview'
import { Explorer } from './components/Explorer'
import { LoginPage } from './components/LoginPage'
import { MobileSidebar, Sidebar } from './components/Sidebar'
import { Button } from './components/ui/button'
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
import type { Session, Storage } from './types'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [storages, setStorages] = useState<Storage[]>([])
  const [storagesLoaded, setStoragesLoaded] = useState(false)
  const [route, setRoute] = useState(readAppRoute)
  const [historyPosition, setHistoryPosition] = useState(initializeBrowserHistory)
  const [booting, setBooting] = useState(true)
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

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
    const desktopQuery = window.matchMedia('(min-width: 768px)')
    const closeMobileSidebarOnDesktop = () => {
      if (desktopQuery.matches) setMobileSidebarOpen(false)
    }
    desktopQuery.addEventListener('change', closeMobileSidebarOnDesktop)
    return () => desktopQuery.removeEventListener('change', closeMobileSidebarOnDesktop)
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
    setMobileSidebarOpen(false)
    await api.logout()
    setSession(null)
  }

  function navigateFromSidebar(nextRoute: AppRoute) {
    setMobileSidebarOpen(false)
    navigate(nextRoute)
  }

  function openAccountSettings() {
    setMobileSidebarOpen(false)
    setAccountSettingsOpen(true)
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
      <Sidebar
        session={session}
        storages={storages}
        page={page}
        selectedStorageId={selectedStorageId}
        collapsed={sidebarCollapsed}
        className="hidden md:flex"
        onNavigate={navigateFromSidebar}
        onAccount={openAccountSettings}
        onLogout={signOut}
        onCollapseToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <MobileHeader
          open={mobileSidebarOpen}
          onToggleSidebar={() => setMobileSidebarOpen((open) => !open)}
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
      <MobileSidebar
        open={mobileSidebarOpen}
        onOpenChange={setMobileSidebarOpen}
        session={session}
        storages={storages}
        page={page}
        selectedStorageId={selectedStorageId}
        onNavigate={navigateFromSidebar}
        onAccount={openAccountSettings}
        onLogout={signOut}
      />
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

function MobileHeader({
  open,
  onToggleSidebar,
}: {
  open: boolean
  onToggleSidebar: () => void
}) {
  return (
    <div className="flex h-14 items-center gap-2 border-b border-slate-200 bg-white px-4 md:hidden">
      <Brand size="sm" className="mr-auto" textClassName="text-sm" />
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={open ? 'Close sidebar' : 'Open sidebar'}
        aria-controls="mobile-sidebar"
        aria-expanded={open}
        onClick={onToggleSidebar}
      >
        <Menu className="size-4" />
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

function accessibleStoragePath(storage: Storage, path: string) {
  const requestedPath = normalizeDirectoryPath(path)
  const roots = storage.roots.map(normalizeDirectoryPath)
  return roots.some((root) => pathIsWithin(requestedPath, root))
    ? requestedPath
    : (roots[0] ?? '')
}

export default App
