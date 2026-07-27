import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function currency(value?: number | null) {
  const numeric = Number(value)
  if (value == null || !Number.isFinite(numeric)) return '--'
  return `¥${numeric.toFixed(2)}`
}

export function timeAgo(value?: string | null) {
  if (!value) return '尚未运行'
  const delta = Date.now() - new Date(value).getTime()
  const minutes = Math.max(0, Math.round(delta / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.round(minutes / 60)} 小时前`
}
