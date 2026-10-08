import { useEffect, useEffectEvent, useState } from 'react'
import { FolderOpen, Upload } from 'lucide-react'
import { isFileDrag, readDroppedItems } from '../lib/dropped-files'
import type { UploadItem } from '../lib/dropped-files'

export function DropUploadOverlay({ disabled, destination, onUpload }: {
  disabled: boolean
  destination: string
  onUpload: (items: Promise<UploadItem[]>) => void
}) {
  const [active, setActive] = useState(false)
  const receiveDrop = useEffectEvent((transfer: DataTransfer) => {
    if (!disabled) onUpload(readDroppedItems(transfer))
  })
  const updateDropEffect = useEffectEvent((transfer: DataTransfer) => {
    transfer.dropEffect = disabled ? 'none' : 'copy'
  })

  useEffect(() => {
    let depth = 0
    const reset = () => { depth = 0; setActive(false) }
    const enter = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      depth += 1
      setActive(true)
    }
    const over = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      updateDropEffect(event.dataTransfer!)
      setActive(true)
    }
    const leave = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0 || !event.relatedTarget) reset()
    }
    const drop = (event: DragEvent) => {
      reset()
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      receiveDrop(event.dataTransfer!)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])

  if (!active) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/65 p-6 backdrop-blur-sm sm:p-10">
      <div role="status" className="flex h-full w-full flex-col items-center justify-center rounded-2xl border-[3px] border-dashed border-white/80 p-6 text-center text-white sm:p-10">
        <span className="mb-5 grid size-16 place-items-center">
          <Upload className="size-8" />
        </span>
        <p className="text-xl font-semibold text-slate-200">
          {disabled ? 'Read-only storage' : 'Drop files or folders to upload'}
        </p>
        {disabled ? (
          <p className="mt-2 text-sm text-white/90">Choose a writable storage to upload files.</p>
        ) : (
          <div className="mt-5 max-w-full">
            <p className="text-sm font-medium text-slate-200">Upload to</p>
            <div className="mt-2 flex max-w-3xl items-start justify-center gap-3 text-white">
              <FolderOpen aria-hidden="true" className="mt-1 size-6 shrink-0" />
              <p className="min-w-0 break-all font-mono text-lg font-semibold normal-case leading-relaxed sm:text-xl">
                {destination}
              </p>
            </div>
          </div>
        )}
        {!disabled && <p className="mt-4 text-xs text-white/75">Folder structure will be preserved</p>}
      </div>
    </div>
  )
}
