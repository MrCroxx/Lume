import { cn } from '../lib/utils'

const iconSizes = {
  sm: 'size-7',
  md: 'size-9',
  lg: 'size-12',
}

export function Brand({
  inverted = false,
  size = 'md',
  className,
  textClassName,
}: {
  inverted?: boolean
  size?: keyof typeof iconSizes
  className?: string
  textClassName?: string
}) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <img
        src="/brand/lume-icon.png"
        alt=""
        aria-hidden="true"
        className={cn(iconSizes[size], 'shrink-0 object-contain', inverted && 'invert')}
      />
      <span className={cn('font-semibold tracking-[-0.025em]', textClassName)}>Lume</span>
    </div>
  )
}
