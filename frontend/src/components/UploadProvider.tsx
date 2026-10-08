import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { UploadQueue } from '../lib/upload-queue'
import { UploadPanel } from './UploadPanel'
import { UploadContext } from '../lib/upload-context'

export function UploadProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(() => new UploadQueue({ directory: api.createDirectory, file: api.upload }))
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const snapshot = queue.getSnapshot()
      if (snapshot.preparing || snapshot.tasks.some((task) => ['queued', 'uploading', 'saving'].includes(task.status))) {
        event.preventDefault()
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      queue.cancelAll()
    }
  }, [queue])
  return (
    <UploadContext.Provider value={queue}>
      {children}
      <UploadPanel queue={queue} />
    </UploadContext.Provider>
  )
}
