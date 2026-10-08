import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, ChevronDown, ChevronUp, CircleAlert, File, Folder, LoaderCircle, Upload, X } from 'lucide-react'
import type { UploadQueue, UploadTask } from '../lib/upload-queue'
import { cn, formatBytes } from '../lib/utils'
import { Button } from './ui/button'

const ROW_HEIGHT = 88
const activeStatuses = ['queued', 'uploading', 'saving']
type Filter = 'all' | 'active' | 'failed'
const uploadBytes = (bytes: number) => bytes === 0 ? '0 B' : formatBytes(bytes)

export function UploadPanel({ queue }: { queue: UploadQueue }) {
  const { tasks, preparing } = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  useEffect(() => {
    if (!tasks.length) { setFilter('all'); setCollapsed(false) }
  }, [tasks.length])
  const active = tasks.filter((task) => activeStatuses.includes(task.status)).length
  const failed = tasks.filter((task) => task.status === 'failed').length
  const complete = tasks.filter((task) => task.status === 'complete').length
  const cancelled = tasks.filter((task) => task.status === 'cancelled').length
  const total = tasks.reduce((sum, task) => sum + task.size, 0)
  const loaded = tasks.reduce((sum, task) => sum + task.loaded, 0)
  const busy = active > 0 || preparing > 0
  const allSuccessful = !preparing && tasks.length > 0 && complete === tasks.length
  useEffect(() => {
    if (allSuccessful) setCollapsed(true)
  }, [allSuccessful])
  const percent = total ? Math.floor(loaded / total * 100) : (tasks.length ? Math.floor(complete / tasks.length * 100) : 0)
  const visible = tasks.filter((task) => filter === 'all' || (filter === 'active' ? activeStatuses.includes(task.status) : task.status === 'failed'))
  if (!tasks.length && !preparing) return null

  return (
    <section aria-label="Upload tasks" className="fixed bottom-4 right-4 z-40 w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-950 shadow-xl sm:w-[440px]">
      <div className="flex items-center gap-3 px-4 py-3">
        <Upload className="size-4 shrink-0 text-slate-600" />
        <button className="min-w-0 flex-1 text-left" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-controls="upload-task-details">
          <span className="block text-sm font-semibold">{busy ? 'Uploading' : failed ? 'Uploads need attention' : 'Uploads finished'}</span>
          <span className="block text-xs text-slate-500">{complete} / {tasks.length} complete{failed ? ` · ${failed} failed` : ''}{cancelled ? ` · ${cancelled} cancelled` : ''}</span>
        </button>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'}>
          {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
        {!busy && !failed && <Button variant="ghost" size="icon" className="size-8" onClick={queue.clearFinished} aria-label="Dismiss uploads"><X className="size-4" /></Button>}
      </div>
      <div className="px-4 pb-3">
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Total bytes sent" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full bg-slate-700 transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        {!collapsed && <p className="mt-2 text-xs text-slate-500">{uploadBytes(loaded)} / {uploadBytes(total)} sent · {percent}%{preparing ? ' · Reading folders…' : ''}</p>}
      </div>
      {!collapsed && <div id="upload-task-details">
        <div className="flex gap-1 overflow-x-auto border-y border-slate-100 px-3 py-2" aria-label="Filter uploads">
          {([['all', `All (${tasks.length})`], ['active', `Active (${active})`], ['failed', `Failed (${failed})`]] as const).map(([value, label]) => (
            <Button key={value} variant={filter === value ? 'secondary' : 'ghost'} size="sm" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>
          ))}
        </div>
        <UploadRows key={filter} tasks={visible} />
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-3 py-2">
          {!!(complete + cancelled) && <Button variant="ghost" size="sm" onClick={queue.clearFinished}>Clear</Button>}
          {!!failed && <Button variant="secondary" size="sm" onClick={queue.retryFailed}>Retry failed</Button>}
          {busy && <Button variant="danger" size="sm" onClick={queue.cancelAll}>Cancel</Button>}
        </div>
      </div>}
    </section>
  )
}

function UploadRows({ tasks }: { tasks: UploadTask[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(320)
  useEffect(() => {
    const element = ref.current!
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const maxScroll = Math.max(0, tasks.length * ROW_HEIGHT - height)
  const offset = Math.min(scrollTop, maxScroll)
  const start = Math.max(0, Math.floor(offset / ROW_HEIGHT) - 2)
  const end = Math.min(tasks.length, Math.ceil((offset + height) / ROW_HEIGHT) + 2)
  return (
    <div ref={ref} className="h-[min(320px,40dvh)] overflow-y-auto overscroll-contain" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      {!tasks.length ? <p className="p-8 text-center text-sm text-slate-400">No uploads in this view</p> : (
        <div role="list" aria-label="Upload progress" className="relative" style={{ height: tasks.length * ROW_HEIGHT }}>
          {tasks.slice(start, end).map((task, index) => <UploadRow key={task.id} task={task} index={start + index} total={tasks.length} />)}
        </div>
      )}
    </div>
  )
}

function UploadRow({ task, index, total }: { task: UploadTask; index: number; total: number }) {
  const percent = task.size ? Math.floor(task.loaded / task.size * 100) : task.status === 'complete' ? 100 : 0
  const name = task.path.replace(/\/$/, '').split('/').at(-1)
  const labels = { queued: 'Queued', uploading: task.kind === 'directory' ? 'Creating folder' : `Uploading · ${percent}%`, saving: 'Saving…', complete: 'Complete', failed: 'Failed', cancelled: 'Cancelled' }
  const Icon = task.status === 'complete' ? Check : task.status === 'failed' ? CircleAlert : ['uploading', 'saving'].includes(task.status) ? LoaderCircle : task.kind === 'directory' ? Folder : File
  return (
    <div role="listitem" aria-posinset={index + 1} aria-setsize={total} className="absolute left-0 right-0 flex gap-3 border-b border-slate-100 px-4 py-3" style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}>
      <Icon className={cn('mt-0.5 size-4 shrink-0 text-slate-400', ['uploading', 'saving'].includes(task.status) && 'animate-spin', task.status === 'failed' && 'text-red-600')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-xs font-medium" title={task.path}>{name}</p>
          <span className={cn('shrink-0 text-[11px] text-slate-500', task.status === 'failed' && 'text-red-600')}>{labels[task.status]}</span>
        </div>
        <p className="mt-0.5 truncate text-[10px] text-slate-400" title={`${task.storageName} / ${task.path}`}>{task.storageName} / {task.path}</p>
        {task.status === 'failed' ? <p className="mt-1 truncate text-[11px] text-red-600" title={task.error}>{task.error}</p> : (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={`${name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="h-full bg-slate-600" style={{ width: `${percent}%` }} />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-slate-400">{task.kind === 'file' ? `${uploadBytes(task.loaded)} / ${uploadBytes(task.size)}` : 'Folder'}</span>
          </div>
        )}
      </div>
    </div>
  )
}
