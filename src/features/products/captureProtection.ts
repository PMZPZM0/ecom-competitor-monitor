import type { AuthSession, Product } from '../../types/domain'

export function productCaptureProtectionUntil(product: Product, sessions: AuthSession[], now = Date.now()) {
  const accountType = product.accountType || 'normal'
  const pool = sessions.filter((session) => (session.enabled ?? session.active) && (session.accountType || 'normal') === accountType)
  if (!pool.length) return null
  const activeCooldowns = pool.map((session) => {
    const timestamp = session.cooldownUntil ? new Date(session.cooldownUntil).getTime() : 0
    return timestamp > now ? timestamp : 0
  })
  if (activeCooldowns.some((timestamp) => timestamp === 0)) return null
  return new Date(Math.min(...activeCooldowns)).toISOString()
}

export function formatProtectionCountdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
