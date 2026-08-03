import type { ReactNode } from 'react'
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import { cn } from '../../lib/utils'

export const DropdownMenu = DropdownPrimitive.Root
export const DropdownMenuTrigger = DropdownPrimitive.Trigger

export function DropdownMenuContent({ children }: { children: ReactNode }) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        align="end"
        sideOffset={6}
        className="z-50 min-w-40 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl outline-none"
      >
        {children}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  children,
  onSelect,
  danger,
}: {
  children: ReactNode
  onSelect?: () => void
  danger?: boolean
}) {
  return (
    <DropdownPrimitive.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-slate-100',
        danger ? 'text-red-600' : 'text-slate-700',
      )}
    >
      {children}
    </DropdownPrimitive.Item>
  )
}
