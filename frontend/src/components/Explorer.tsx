import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { normalizeDirectoryPath, pathIsWithin } from '../lib/routes'
import { cn, formatBytes, formatDate } from '../lib/utils'
import type { FileEntry, Storage } from '../types'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'

export function Explorer({
  storage,
  path: currentPath,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onNavigate,
}: {
  storage: Storage
  path: string
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onNavigate: (path: string) => void
}) {
  const path = normalizeDirectoryPath(currentPath)
  const storageRoot = selectStorageRoot(storage.roots, path)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [searchResults, setSearchResults] = useState<FileEntry[]>([])
  const [query, setQuery] = useState('')
  const [listLoading, setListLoading] = useState(true)
  const [searchLoading, setSearchLoading] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)
  const listRequestId = useRef(0)
  const searchRequestId = useRef(0)

  const loadFiles = useCallback(async () => {
    const currentRequest = ++listRequestId.current
    setListLoading(true)
    try {
      const nextEntries = await api.files(storage.id, path)
      if (listRequestId.current === currentRequest) setEntries(nextEntries)
    } catch (reason) {
      if (listRequestId.current === currentRequest) {
        toast.error(reason instanceof Error ? reason.message : 'Unable to load files')
      }
    } finally {
      if (listRequestId.current === currentRequest) setListLoading(false)
    }
  }, [storage.id, path])

  useEffect(() => {
    setQuery('')
  }, [storage.id, path])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  useEffect(() => {
    const currentRequest = ++searchRequestId.current
    if (query.trim().length < 2) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }
    const handle = window.setTimeout(async () => {
      try {
        setSearchLoading(true)
        const nextResults = await api.search(storage.id, path, query.trim())
        if (searchRequestId.current === currentRequest) setSearchResults(nextResults)
      } catch (reason) {
        if (searchRequestId.current === currentRequest) {
          toast.error(reason instanceof Error ? reason.message : 'Search failed')
        }
      } finally {
        if (searchRequestId.current === currentRequest) setSearchLoading(false)
      }
    }, 280)
    return () => window.clearTimeout(handle)
  }, [query, path, storage.id])

  async function createFolder() {
    const name = folderName.trim().replaceAll('/', '')
    if (!name) return
    try {
      await api.createDirectory(storage.id, joinPath(path, `${name}/`))
      setFolderOpen(false)
      setFolderName('')
      toast.success(`Created ${name}`)
      await loadFiles()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to create folder')
    }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return
    const toastId = toast.loading(`Uploading ${files.length} item${files.length > 1 ? 's' : ''}…`)
    try {
      for (const file of files) {
        await api.upload(storage.id, joinPath(path, file.name), file)
      }
      toast.success('Upload complete', { id: toastId })
      await loadFiles()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Upload failed', { id: toastId })
    } finally {
      if (uploadRef.current) uploadRef.current.value = ''
    }
  }

  async function remove(entry: FileEntry) {
    if (!window.confirm(`Delete “${entry.name}”? This action cannot be undone.`)) return
    try {
      await api.remove(storage.id, entry)
      toast.success(`Deleted ${entry.name}`)
      await loadFiles()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Delete failed')
    }
  }

  const navigateTo = useCallback((nextPath: string) => {
    onNavigate(normalizeDirectoryPath(nextPath))
    setQuery('')
  }, [onNavigate])

  const breadcrumbs = useMemo(() => breadcrumbItems(path, storageRoot), [path, storageRoot])
  const parent = useMemo(() => parentDirectory(path, storageRoot), [path, storageRoot])
  const loading = listLoading || searchLoading
  const visibleEntries = query.trim().length >= 2 ? searchResults : entries

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-slate-200 bg-white px-5 py-4 sm:px-8">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="icon"
              disabled={!canGoBack}
              onClick={onBack}
              aria-label="Go back"
              title="Go back"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              disabled={!canGoForward}
              onClick={onForward}
              aria-label="Go forward"
              title="Go forward"
            >
              <ArrowRight className="size-4" />
            </Button>
          </div>
          <Button
            variant="secondary"
            size="icon"
            disabled={parent === null}
            onClick={() => {
              if (parent === null) return
              navigateTo(parent)
            }}
            aria-label="Go to parent directory"
            title="Go to parent directory"
          >
            <ArrowUp className="size-4" />
          </Button>
          <div className="mr-auto flex min-w-0 items-center gap-1 text-sm">
            <button
              className="rounded-md px-1.5 py-1 font-semibold text-slate-950 hover:bg-slate-100"
              onClick={() => navigateTo(storageRoot)}
            >
              {storage.name}
            </button>
            {breadcrumbs.map((crumb) => (
              <span className="flex min-w-0 items-center gap-1" key={crumb.path}>
                <ChevronRight className="size-3.5 shrink-0 text-slate-300" />
                <button
                  className="max-w-40 truncate rounded-md px-1.5 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-950"
                  onClick={() => navigateTo(crumb.path)}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>
          <div className="relative order-last w-full sm:order-none sm:w-72">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              className="h-9 bg-slate-50 pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search in ${storage.name}`}
              aria-label="Search files"
            />
          </div>
          <Button variant="secondary" size="icon" onClick={() => void loadFiles()} aria-label="Refresh">
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
          {storage.can_write && (
            <>
              <Button variant="secondary" onClick={() => setFolderOpen(true)}>
                <Plus className="size-4" />
                <span className="hidden sm:inline">New folder</span>
              </Button>
              <Button onClick={() => uploadRef.current?.click()}>
                <Upload className="size-4" />
                Upload
              </Button>
              <input
                ref={uploadRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => void upload(event.target.files)}
              />
            </>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto overscroll-contain bg-[#f7f8f9] p-5 sm:p-8">
        <section className="mx-auto max-w-[1500px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.025)]">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div>
              <h1 className="text-sm font-semibold text-slate-950">
                {query.trim().length >= 2 ? `Results for “${query.trim()}”` : 'Files'}
              </h1>
              <p className="mt-0.5 text-xs text-slate-400">
                {visibleEntries.length} item{visibleEntries.length === 1 ? '' : 's'} · {storage.kind.toUpperCase()}
              </p>
            </div>
          </div>

          <div className="min-w-[680px]">
            <div className="grid grid-cols-[minmax(300px,1fr)_120px_190px_48px] border-b border-slate-100 px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
              <span>Name</span>
              <span>Size</span>
              <span>Modified</span>
              <span />
            </div>
            {loading && visibleEntries.length === 0 ? (
              <div className="grid h-64 place-items-center text-slate-400">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
            ) : visibleEntries.length === 0 ? (
              <EmptyState search={query.trim().length >= 2} />
            ) : (
              visibleEntries.map((entry) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  storage={storage}
                  onOpen={() => {
                    if (entry.kind === 'directory') {
                      navigateTo(ensureDirectory(entry.path))
                    } else {
                      window.location.assign(api.downloadUrl(storage.id, entry.path))
                    }
                  }}
                  onDelete={() => void remove(entry)}
                />
              ))
            )}
          </div>
        </section>
      </main>

      <Dialog
        open={folderOpen}
        onOpenChange={setFolderOpen}
        title="Create a folder"
        description={`Add a new directory inside ${path || storage.name}.`}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void createFolder()
          }}
        >
          <label className="text-sm font-medium text-slate-700" htmlFor="folder-name">
            Folder name
          </label>
          <Input
            id="folder-name"
            className="mt-2"
            autoFocus
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            placeholder="Project files"
          />
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setFolderOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!folderName.trim()}>
              Create folder
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}

function FileRow({
  entry,
  storage,
  onOpen,
  onDelete,
}: {
  entry: FileEntry
  storage: Storage
  onOpen: () => void
  onDelete: () => void
}) {
  const Icon = fileIcon(entry)
  return (
    <div className="group grid grid-cols-[minmax(300px,1fr)_120px_190px_48px] items-center border-b border-slate-100 px-5 py-2.5 last:border-0 hover:bg-slate-50/80">
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

function EmptyState({ search }: { search: boolean }) {
  return (
    <div className="grid h-64 place-items-center px-6 text-center">
      <div>
        <span className="mx-auto grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-400">
          {search ? <Search className="size-5" /> : <FolderOpen className="size-5" />}
        </span>
        <p className="mt-4 text-sm font-medium text-slate-700">
          {search ? 'No matching files' : 'This folder is empty'}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {search ? 'Try a different name or location.' : 'Upload a file to get started.'}
        </p>
      </div>
    </div>
  )
}

function fileIcon(entry: FileEntry) {
  if (entry.kind === 'directory') return Folder
  const extension = entry.name.split('.').pop()?.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension ?? '')) return FileImage
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(extension ?? '')) return FileArchive
  if (['rs', 'go', 'py', 'js', 'ts', 'tsx', 'json', 'toml', 'yaml', 'yml'].includes(extension ?? ''))
    return FileCode2
  if (['txt', 'md', 'pdf', 'doc', 'docx'].includes(extension ?? '')) return FileText
  return File
}

function ensureDirectory(path: string) {
  return normalizeDirectoryPath(path)
}

function joinPath(parent: string, child: string) {
  return `${parent.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}`.replace(/^\//, '')
}

function breadcrumbItems(path: string, root: string) {
  const parts = path.split('/').filter(Boolean)
  const rootParts = root.split('/').filter(Boolean)
  const hasRootPrefix = rootParts.every((part, index) => parts[index] === part)
  const visibleParts = hasRootPrefix ? parts.slice(rootParts.length) : parts
  const prefixParts = hasRootPrefix ? rootParts : []
  return visibleParts.map((name, index) => ({
    name,
    path: `${[...prefixParts, ...visibleParts.slice(0, index + 1)].join('/')}/`,
  }))
}

function parentDirectory(path: string, root: string) {
  const parts = path.split('/').filter(Boolean)
  const rootParts = root.split('/').filter(Boolean)
  if (parts.length <= rootParts.length) return null
  const parent = parts.slice(0, -1).join('/')
  return parent ? `${parent}/` : ''
}

function selectStorageRoot(roots: string[], path: string) {
  const normalizedRoots = roots.map(normalizeDirectoryPath)
  return (
    normalizedRoots
      .filter((root) => pathIsWithin(path, root))
      .sort((left, right) => right.length - left.length)[0] ??
    normalizedRoots[0] ??
    ''
  )
}
