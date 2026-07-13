export function scheduleInputParts(monitorStartAt: string | null | undefined, nextMonitorAt: string | null | undefined, intervalMinutes: number) {
  const fallbackAt = Date.now() + intervalMinutes * 60_000
  const parsed = new Date(monitorStartAt || nextMonitorAt || fallbackAt)
  const value = Number.isNaN(parsed.getTime()) ? new Date(fallbackAt) : parsed
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  const hours = String(value.getHours()).padStart(2, '0')
  const minutes = String(value.getMinutes()).padStart(2, '0')
  return { date: `${year}-${month}-${day}`, time: `${hours}:${minutes}` }
}
