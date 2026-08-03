import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  Cable,
  Database,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  MoreHorizontal,
  Network,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { cn, formatBytes, formatDate } from '../lib/utils'
import type { FileEntry, Storage } from '../types'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'

interface AggregatedEntry {
  storage: Storage
  entry: FileEntry
}

interface ConnectionState {
  count: number
  error?: string
}

const MAX_RENDERED_ENTRIES = 1_000

export function ConnectionsOverview({
  storages,
  onOpenStorage,
}: {
  storages: Storage[]
  onOpenStorage: (storageId: string, path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [resultQuery, setResultQuery] = useState('')
  const [entries, setEntries] = useState<AggregatedEntry[]>([])
  const [connectionStates, setConnectionStates] = useState<Record<string, ConnectionState>>({})
  const [loading, setLoading] = useState(true)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const requestId = useRef(0)

  const load = useCallback(
    async (term: string, currentRequest: number) => {
      const isSearch = term.length >= 2
      setLoading(true)

      const requests = storages.flatMap((storage) =>
        storage.roots.map(async (root) => ({
          storage,
          entries: isSearch
            ? await api.search(storage.id, root, term)
            : await api.files(storage.id, root),
        })),
      )
      const results = await Promise.allSettled(requests)
      if (requestId.current !== currentRequest) return

      const nextEntries = new Map<string, AggregatedEntry>()
      const nextStates: Record<string, ConnectionState> = Object.fromEntries(
        storages.map((storage) => [storage.id, { count: 0 }]),
      )

      results.forEach((result) => {
        if (result.status === 'rejected') return
        const { storage, entries: storageEntries } = result.value
        nextStates[storage.id].count += storageEntries.length
        storageEntries.forEach((entry) => {
          nextEntries.set(`${storage.id}:${entry.path}`, { storage, entry })
        })
      })

      results.forEach((result, index) => {
        if (result.status !== 'rejected') return
        const storage = requestsFor(storages)[index]?.storage
        if (!storage) return
        nextStates[storage.id].error =
          result.reason instanceof Error ? result.reason.message : 'Connection unavailable'
      })

      const sorted = [...nextEntries.values()].sort((left, right) => {
        const directoryOrder =
          Number(right.entry.kind === 'directory') - Number(left.entry.kind === 'directory')
        if (directoryOrder !== 0) return directoryOrder
        return left.entry.name.localeCompare(right.entry.name, undefined, { sensitivity: 'base' })
      })
      setEntries(sorted)
      setConnectionStates(nextStates)
      setResultQuery(term)
      setLoading(false)
    },
    [storages],
  )

  useEffect(() => {
    const currentRequest = ++requestId.current
    const term = query.trim()
    const effectiveTerm = term.length >= 2 ? term : ''
    const handle = window.setTimeout(
      () => void load(effectiveTerm, currentRequest),
      effectiveTerm ? 280 : 0,
    )
    return () => window.clearTimeout(handle)
  }, [query, load, refreshVersion])

  async function remove(storage: Storage, entry: FileEntry) {
    if (!window.confirm(`Delete “${entry.name}” from ${storage.name}? This action cannot be undone.`))
      return
    try {
      await api.remove(storage.id, entry)
      toast.success(`Deleted ${entry.name}`)
      setRefreshVersion((version) => version + 1)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Delete failed')
    }
  }

  const isSearch = resultQuery.length >= 2
  const visibleEntries = entries.slice(0, MAX_RENDERED_ENTRIES)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-slate-200 bg-white px-5 py-4 sm:px-8">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3">
          <div className="mr-auto">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-400">
              Global view
            </p>
            <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-950">
              All connections
            </h1>
          </div>
          <div className="relative order-last w-full sm:order-none sm:w-80">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              className="h-9 bg-slate-50 pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search across all connections"
              aria-label="Search across all connections"
            />
          </div>
          <Button
            variant="secondary"
            size="icon"
            onClick={() => setRefreshVersion((version) => version + 1)}
            aria-label="Refresh all connections"
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto overscroll-contain bg-[#f7f8f9] p-5 sm:p-8">
        <div className="mx-auto max-w-[1500px] space-y-6">
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {storages.map((storage) => {
              const Icon = storageIcon(storage.kind)
              const state = connectionStates[storage.id]
              return (
                <button
                  key={storage.id}
                  onClick={() => onOpenStorage(storage.id, storage.roots[0] ?? '')}
                  className="group flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.025)] transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
                >
                  <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-slate-950 text-white">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">
                      {storage.name}
                    </span>
                    <span className="mt-1 block text-xs text-slate-400">
                      {state?.error
                        ? 'Connection unavailable'
                        : `${state?.count ?? 0} ${isSearch ? 'matches' : 'root items'}`}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      state?.error ? 'bg-red-400' : loading ? 'bg-amber-300' : 'bg-emerald-400',
                    )}
                  />
                </button>
              )
            })}
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.025)]">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-950">
                  {isSearch ? `Results for “${resultQuery}”` : 'Combined root contents'}
                </h2>
                <p className="mt-0.5 text-xs text-slate-400">
                  {entries.length} item{entries.length === 1 ? '' : 's'} across {storages.length}{' '}
                  connection{storages.length === 1 ? '' : 's'}
                </p>
              </div>
              {entries.length > MAX_RENDERED_ENTRIES && (
                <span className="text-xs text-amber-600">
                  Showing first {MAX_RENDERED_ENTRIES.toLocaleString()}
                </span>
              )}
            </div>

            <div className="min-w-[860px]">
              <div className="grid grid-cols-[minmax(280px,1fr)_180px_110px_190px_48px] border-b border-slate-100 px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
                <span>Name</span>
                <span>Connection</span>
                <span>Size</span>
                <span>Modified</span>
                <span />
              </div>
              {loading && entries.length === 0 ? (
                <div className="grid h-64 place-items-center text-slate-400">
                  <LoaderCircle className="size-5 animate-spin" />
                </div>
              ) : visibleEntries.length === 0 ? (
                <div className="grid h-64 place-items-center px-6 text-center">
                  <div>
                    <span className="mx-auto grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-400">
                      {isSearch ? <Search className="size-5" /> : <FolderOpen className="size-5" />}
                    </span>
                    <p className="mt-4 text-sm font-medium text-slate-700">
                      {isSearch ? 'No matches across your connections' : 'No files are visible'}
                    </p>
                  </div>
                </div>
              ) : (
                visibleEntries.map(({ storage, entry }) => (
                  <AggregatedFileRow
                    key={`${storage.id}:${entry.path}`}
                    storage={storage}
                    entry={entry}
                    onOpen={() => {
                      if (entry.kind === 'directory') {
                        onOpenStorage(storage.id, ensureDirectory(entry.path))
                      } else {
                        window.location.assign(api.downloadUrl(storage.id, entry.path))
                      }
                    }}
                    onOpenStorage={() =>
                      onOpenStorage(storage.id, storage.roots[0] ?? '')
                    }
                    onDelete={() => void remove(storage, entry)}
                  />
                ))
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}

function AggregatedFileRow({
  storage,
  entry,
  onOpen,
  onOpenStorage,
  onDelete,
}: {
  storage: Storage
  entry: FileEntry
  onOpen: () => void
  onOpenStorage: () => void
  onDelete: () => void
}) {
  const Icon = entry.kind === 'directory' ? Folder : File
  return (
    <div className="group grid grid-cols-[minmax(280px,1fr)_180px_110px_190px_48px] items-center border-b border-slate-100 px-5 py-2.5 last:border-0 hover:bg-slate-50/80">
      <button className="flex min-w-0 items-center gap-3 text-left" onClick={onOpen}>
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-lg',
            entry.kind === 'directory' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500',
          )}
        >
          <Icon className="size-[18px]" strokeWidth={1.7} />
        </span>
        <span className="truncate text-sm font-medium text-slate-700 group-hover:text-slate-950">
          {entry.name}
        </span>
      </button>
      <button
        className="w-fit max-w-40 truncate rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
        onClick={onOpenStorage}
      >
        {storage.name}
      </button>
      <span className="font-mono text-xs text-slate-400">
        {entry.kind === 'directory' ? '—' : formatBytes(entry.size)}
      </span>
      <span className="text-xs text-slate-500">{formatDate(entry.modified_at)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8 opacity-0 group-hover:opacity-100">
            <MoreHorizontal className="size-4" />
            <span className="sr-only">Open actions for {entry.name}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {entry.kind === 'file' && (
            <DropdownMenuItem
              onSelect={() => window.location.assign(api.downloadUrl(storage.id, entry.path))}
            >
              <ArrowDownToLine className="size-4" />
              Download
            </DropdownMenuItem>
          )}
          {storage.can_write && (
            <DropdownMenuItem danger onSelect={onDelete}>
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function requestsFor(storages: Storage[]) {
  return storages.flatMap((storage) => storage.roots.map((root) => ({ storage, root })))
}

function storageIcon(kind: Storage['kind']) {
  if (kind === 'webdav' || kind === 'ftp' || kind === 'sftp') return Network
  if (kind === 's3') return Database
  if (kind === 'fs' || kind === 'smb') return HardDrive
  return Cable
}

function ensureDirectory(path: string) {
  return path.endsWith('/') ? path : `${path}/`
}
