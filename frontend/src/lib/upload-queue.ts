import type { UploadItem } from './dropped-files'

export type UploadStatus = 'queued' | 'uploading' | 'saving' | 'complete' | 'failed' | 'cancelled'
export interface UploadTask {
  id: number
  storageId: string
  storageName: string
  path: string
  kind: UploadItem['kind']
  size: number
  loaded: number
  status: UploadStatus
  error?: string
}
interface Task extends UploadTask {
  file?: File
  parent?: Task
  controller?: AbortController
}
export interface UploadTransport {
  directory: (storageId: string, path: string, signal: AbortSignal) => Promise<void>
  file: (storageId: string, path: string, file: File, options: {
    signal: AbortSignal
    onProgress: (loaded: number) => void
    onSent: () => void
  }) => Promise<void>
}
export interface UploadSnapshot {
  tasks: UploadTask[]
  preparing: number
  revision: number
}

export class UploadQueue {
  private tasks: Task[] = []
  private listeners = new Set<() => void>()
  private snapshot: UploadSnapshot = { tasks: [], preparing: 0, revision: 0 }
  private preparing = 0
  private generation = 0
  private nextId = 1
  private running = 0
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private transport: UploadTransport

  constructor(transport: UploadTransport) { this.transport = transport }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish = () => {
    clearTimeout(this.timer)
    this.timer = undefined
    this.snapshot = {
      tasks: this.tasks.map(({ file: _file, parent: _parent, controller: _controller, ...task }) => ({ ...task })),
      preparing: this.preparing,
      revision: this.revision,
    }
    this.listeners.forEach((listener) => listener())
  }
  private progress() {
    if (!this.timer) this.timer = setTimeout(this.publish, 100)
  }

  async add(storageId: string, storageName: string, basePath: string, items: Promise<UploadItem[]>) {
    const generation = this.generation
    this.preparing += 1
    this.publish()
    try {
      const entries = await items
      if (generation !== this.generation) return
      if (!entries.length) throw new Error('No files or folders could be read')
      const directories = new Map<string, Task>()
      const added = entries.map((item): Task => {
        const task: Task = {
          id: this.nextId++, storageId, storageName,
          path: `${basePath}${item.path}`, kind: item.kind,
          size: item.kind === 'file' ? item.file.size : 0,
          file: item.kind === 'file' ? item.file : undefined,
          loaded: 0, status: 'queued',
        }
        if (item.kind === 'directory') directories.set(item.path, task)
        return task
      })
      entries.forEach((item, index) => {
        const trimmed = item.path.replace(/\/$/, '')
        const slash = trimmed.lastIndexOf('/')
        if (slash >= 0) added[index].parent = directories.get(trimmed.slice(0, slash + 1))
      })
      this.tasks.push(...added)
    } finally {
      this.preparing -= 1
      this.pump()
    }
  }

  private pump() {
    for (const task of this.tasks) {
      if (task.status !== 'queued') continue
      if (task.parent && ['failed', 'cancelled'].includes(task.parent.status)) {
        task.status = 'failed'
        task.error = 'Parent folder was not created. Retry failed items to try again.'
        continue
      }
      if (task.parent && task.parent.status !== 'complete') continue
      if (this.running >= 3) break
      // Serialize overlapping destinations, including batches added during an upload.
      if (this.tasks.some((other) => other.id !== task.id && other.storageId === task.storageId &&
        (['uploading', 'saving'].includes(other.status) || (other.id < task.id && other.status === 'queued')) &&
        (other.path === task.path || (other.kind === 'directory' && task.path.startsWith(other.path)) ||
          (task.kind === 'directory' && other.path.startsWith(task.path))))) continue
      this.running += 1
      task.status = 'uploading'
      task.controller = new AbortController()
      void this.run(task)
    }
    this.publish()
  }

  private async run(task: Task) {
    try {
      const signal = task.controller!.signal
      if (task.kind === 'directory') {
        await this.transport.directory(task.storageId, task.path, signal)
      } else {
        await this.transport.file(task.storageId, task.path, task.file!, {
          signal,
          onProgress: (loaded) => {
            if (task.status !== 'uploading') return
            task.loaded = Math.max(task.loaded, Math.min(loaded, task.size))
            this.progress()
          },
          onSent: () => {
            if (task.status !== 'uploading') return
            task.loaded = task.size
            task.status = 'saving'
            this.publish()
          },
        })
      }
      if (task.status !== 'cancelled') {
        task.status = 'complete'
        task.loaded = task.size
        task.file = undefined
        this.revision += 1
      }
    } catch (reason) {
      if (task.status !== 'cancelled') {
        task.status = 'failed'
        task.error = reason instanceof Error ? reason.message : 'Upload failed'
      }
    } finally {
      task.controller = undefined
      this.running -= 1
      this.pump()
    }
  }

  cancelAll = () => {
    this.generation += 1
    for (const task of this.tasks) {
      if (['queued', 'uploading', 'saving'].includes(task.status)) {
        task.status = 'cancelled'
        task.file = undefined
        task.controller?.abort()
      }
    }
    this.publish()
  }
  retryFailed = () => {
    for (const task of this.tasks) {
      if (task.status === 'failed') {
        task.status = 'queued'
        task.loaded = 0
        task.error = undefined
      }
    }
    this.pump()
  }
  clearFinished = () => {
    this.tasks = this.tasks.filter((task) => !['complete', 'cancelled'].includes(task.status))
    this.publish()
  }
}
