import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({ className, variant = 'primary', size = 'md', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium transition disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
        variant === 'primary' && 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
        variant === 'secondary' && 'border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-800',
        variant === 'ghost' && 'border-transparent bg-transparent text-slate-600 hover:bg-slate-100',
        variant === 'danger' && 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100',
        className,
      )}
      {...props}
    />
  )
}
