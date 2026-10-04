import type { ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  size = 'default',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  size?: 'default' | 'wide'
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl outline-none sm:w-[calc(100%-2rem)] sm:p-6',
            size === 'wide' ? 'max-w-3xl' : 'max-w-md',
          )}
        >
          <div className="shrink-0 pr-8">
            <DialogPrimitive.Title className="text-lg font-semibold tracking-tight text-slate-950">
              {title}
            </DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="mt-1 max-h-[20dvh] overflow-y-auto break-words text-sm leading-6 text-slate-500 [overflow-wrap:anywhere]">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
          <div className="mt-5 min-h-0 overflow-y-auto overscroll-contain">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
