import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700',
        className,
      )}
      {...props}
    />
  )
}
