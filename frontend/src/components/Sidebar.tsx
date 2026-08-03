import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  FolderKanban,
  HardDrive,
  Layers3,
  LogOut,
  Network,
  ShieldCheck,
  UserCog,
  X,
} from 'lucide-react'
import { Brand } from './Brand'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import type { AppRoute } from '../lib/routes'
import { cn } from '../lib/utils'
import type { Session, Storage } from '../types'

interface SidebarProps {
  session: Session
  storages: Storage[]
  page: AppRoute['page']
  selectedStorageId: string | null
  collapsed?: boolean
  className?: string
  onNavigate: (route: AppRoute) => void
  onAccount: () => void
  onLogout: () => Promise<void>
  onCollapseToggle?: () => void
  onClose?: () => void
}

export function Sidebar({
  session,
  storages,
  page,
  selectedStorageId,
  collapsed = false,
  className,
  onNavigate,
  onAccount,
  onLogout,
  onCollapseToggle,
  onClose,
}: SidebarProps) {
  return (
    <aside
      aria-label="Primary navigation"
      className={cn(
        'relative shrink-0 flex-col border-r border-slate-800 bg-[#111820] text-white transition-[width] duration-200 motion-reduce:transition-none',
        collapsed ? 'w-14' : 'w-64',
        className,
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center transition-[height] duration-200 motion-reduce:transition-none',
          collapsed
            ? 'h-14 justify-center px-2'
            : 'h-[73px] gap-3 border-b border-white/5 px-5',
        )}
      >
        {collapsed ? (
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-expanded={false}
            title="Expand sidebar"
            onClick={onCollapseToggle}
            className="group relative grid size-9 place-items-center rounded-lg transition-colors hover:bg-white/7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <Brand
              inverted
              size="sm"
              className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0 [&>span]:hidden"
              textClassName="text-lg text-white"
            />
            <ChevronRight className="absolute size-4 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <Brand inverted size="sm" textClassName="text-lg text-white" />
            <p className="mt-1 text-[10px] text-slate-500">Unified file workspace</p>
          </div>
        )}

        {onCollapseToggle && !collapsed && (
          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-expanded={true}
            title="Collapse sidebar"
            onClick={onCollapseToggle}
            className="grid size-7 shrink-0 place-items-center rounded-md text-slate-500 transition-colors hover:bg-white/7 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}

        {onClose && (
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={onClose}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <nav className={cn('p-3', collapsed && 'px-2 py-2')}>
        <SidebarNavButton
          active={page === 'files'}
          collapsed={collapsed}
          icon={FolderKanban}
          label="Files"
          onClick={() => onNavigate({ page: 'files', storageId: null, path: '' })}
        />
        {session.user.role === 'admin' && (
          <SidebarNavButton
            active={page === 'admin'}
            collapsed={collapsed}
            icon={ShieldCheck}
            label="Administration"
            onClick={() => onNavigate({ page: 'admin' })}
          />
        )}
      </nav>

      <div className={cn('border-t border-white/7', collapsed ? 'mx-3' : 'mx-4')} />
      <div
        className={cn(
          'min-h-0 flex-1 overflow-auto',
          collapsed ? 'px-2 py-2' : 'px-3 py-5',
        )}
      >
        {!collapsed && (
          <p className="mb-2 px-2 font-mono text-[9px] uppercase tracking-[0.18em] text-slate-600">
            Storage connections
          </p>
        )}
        <div className="space-y-1">
          <StorageButton
            active={page === 'files' && selectedStorageId === null}
            collapsed={collapsed}
            icon={Layers3}
            label="All connections"
            kind="ALL"
            onClick={() => onNavigate({ page: 'files', storageId: null, path: '' })}
          />
          {storages.map((storage) => (
            <StorageButton
              key={storage.id}
              active={page === 'files' && storage.id === selectedStorageId}
              collapsed={collapsed}
              icon={storageIcon(storage.kind)}
              label={storage.name}
              kind={storage.kind}
              onClick={() =>
                onNavigate({
                  page: 'files',
                  storageId: storage.id,
                  path: storage.roots[0] ?? '',
                })
              }
            />
          ))}
        </div>
      </div>

      <div className={cn('border-t border-white/5 p-3', collapsed && 'px-2')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Account menu for ${session.user.username}`}
              title={collapsed ? session.user.username : undefined}
              className={cn(
                'flex w-full items-center rounded-xl p-2 text-left transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400',
                collapsed ? 'justify-center' : 'gap-3',
              )}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-emerald-400 text-xs font-semibold text-slate-950">
                {session.user.username.slice(0, 2).toUpperCase()}
              </span>
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-200">
                      {session.user.username}
                    </span>
                    <span className="block text-[10px] capitalize text-slate-500">
                      {session.auth_method === 'bypass' ? 'Trusted network' : session.user.role}
                    </span>
                  </span>
                  <ChevronDown className="size-3.5 text-slate-600" />
                </>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {session.auth_method === 'session' && (
              <DropdownMenuItem onSelect={onAccount}>
                <UserCog className="size-4" />
                Account settings
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => void onLogout()}>
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  )
}

type MobileSidebarProps = Omit<
  SidebarProps,
  'collapsed' | 'className' | 'onCollapseToggle' | 'onClose'
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MobileSidebar({ open, onOpenChange, ...sidebarProps }: MobileSidebarProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="mobile-sidebar-overlay fixed inset-0 z-40 bg-slate-950/45 backdrop-blur-[2px] md:hidden" />
        <DialogPrimitive.Content
          id="mobile-sidebar"
          className="mobile-sidebar-panel fixed inset-y-0 left-0 z-50 w-[min(20rem,calc(100vw-3rem))] outline-none md:hidden"
        >
          <DialogPrimitive.Title className="sr-only">Navigation sidebar</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Choose a workspace section or storage connection.
          </DialogPrimitive.Description>
          <Sidebar
            {...sidebarProps}
            className="flex h-full w-full border-r-0 shadow-2xl"
            onClose={() => onOpenChange(false)}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function SidebarNavButton({
  active,
  collapsed,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  collapsed: boolean
  icon: typeof FolderKanban
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      onClick={onClick}
      className={cn(
        'mb-1 flex w-full items-center rounded-lg py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400',
        collapsed ? 'justify-center px-0' : 'gap-3 px-2.5',
        active ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className={collapsed ? 'sr-only' : undefined}>{label}</span>
    </button>
  )
}

function StorageButton({
  active,
  collapsed,
  icon: Icon,
  label,
  kind,
  onClick,
}: {
  active: boolean
  collapsed: boolean
  icon: typeof Database
  label: string
  kind: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'location' : undefined}
      title={collapsed ? label : undefined}
      onClick={onClick}
      className={cn(
        'flex w-full items-center rounded-lg py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400',
        collapsed ? 'justify-center px-0' : 'gap-3 px-2.5',
        active ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className={cn('min-w-0 flex-1 truncate', collapsed && 'sr-only')}>{label}</span>
      {!collapsed && (
        <span className="font-mono text-[9px] uppercase text-slate-600">{kind}</span>
      )}
    </button>
  )
}

function storageIcon(kind: Storage['kind']) {
  if (kind === 'webdav' || kind === 'ftp' || kind === 'sftp') return Network
  if (kind === 's3') return Database
  return HardDrive
}
