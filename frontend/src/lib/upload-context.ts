import { createContext, useContext } from 'react'
import type { UploadQueue } from './upload-queue'

export const UploadContext = createContext<UploadQueue | null>(null)

export function useUploadQueue() {
  const queue = useContext(UploadContext)
  if (!queue) throw new Error('UploadProvider is missing')
  return queue
}
