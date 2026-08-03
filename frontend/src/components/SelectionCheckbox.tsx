import { useEffect, useRef } from 'react'

export function SelectionCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  label,
  onToggle,
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  label: string
  onToggle: (range: boolean) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label className="-ml-2 grid size-9 place-items-center rounded-md hover:bg-slate-200/70 has-focus-visible:ring-2 has-focus-visible:ring-slate-400">
      <input
        ref={inputRef}
        type="checkbox"
        className="size-4 cursor-pointer rounded border-slate-300 accent-slate-950 focus:outline-none disabled:cursor-default"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={() => {}}
        onClick={(event) => onToggle(event.shiftKey)}
      />
    </label>
  )
}
