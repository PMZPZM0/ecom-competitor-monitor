import { useEffect, useMemo, useState } from 'react'
import { BellRing, Check, CircleAlert, LoaderCircle, RefreshCw, Send } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { api } from '../../lib/api'
import type { OperationsWorkspace, QwenPawAlertSettings as AlertSettings, QwenPawFeishuTarget } from '../../types/domain'

type Props = { workspace: OperationsWorkspace }
const emptySettings: AlertSettings = { belowThresholdTargets: [], loginExpiredTargets: [] }

function keyOf(target: QwenPawFeishuTarget) {
  return `${target.channel}:${target.userId}:${target.sessionId}`
}

function titleOf(target: QwenPawFeishuTarget) {
  return target.label || target.userId || target.sessionId
}

function hasTarget(list: QwenPawFeishuTarget[], target: QwenPawFeishuTarget) {
  return list.some((item) => keyOf(item) === keyOf(target))
}

function toggle(list: QwenPawFeishuTarget[], target: QwenPawFeishuTarget) {
  return hasTarget(list, target) ? list.filter((item) => keyOf(item) !== keyOf(target)) : [...list, target]
}

export function QwenPawAlertSettings({ workspace }: Props) {
  const [settings, setSettings] = useState<AlertSettings>(workspace.qwenPawAlerts || emptySettings)
  const [targets, setTargets] = useState<QwenPawFeishuTarget[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => setSettings(workspace.qwenPawAlerts || emptySettings), [workspace.qwenPawAlerts])

  const selectedCount = useMemo(() => new Set([
    ...settings.belowThresholdTargets.map(keyOf),
    ...settings.loginExpiredTargets.map(keyOf),
  ]).size, [settings])

  async function refresh() {
    setBusy('refresh')
    setError('')
    try {
      const result = await api.qwenPawFeishuTargets()
      setTargets(result.targets)
      setMessage(result.message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '未能读取 QwenPaw 飞书会话。')
    } finally {
      setBusy('')
    }
  }

  async function save() {
    setBusy('save')
    setError('')
    try {
      const saved = await api.updateQwenPawAlerts(settings)
      setSettings(saved)
      setMessage('提醒目标已保存。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提醒目标保存失败。')
    } finally {
      setBusy('')
    }
  }

  async function test(target: QwenPawFeishuTarget) {
    setBusy(`test:${keyOf(target)}`)
    setError('')
    try {
      await api.testQwenPawFeishuTarget(target)
      setMessage(`测试消息已发送至 ${titleOf(target)}。`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'QwenPaw 飞书测试未发送。')
    } finally {
      setBusy('')
    }
  }

  return <Card>
    <CardHeader className="flex-row items-center justify-between gap-3">
      <div className="min-w-0">
        <CardTitle className="flex items-center gap-2"><BellRing className="h-4 w-4 text-blue-700" />QwenPaw 主动提醒</CardTitle>
        <p className="mt-1 text-xs font-normal leading-5 text-slate-500">只使用 QwenPaw 自己绑定的飞书私聊和群聊；账号掉线会附带限时登录二维码并自动撤回，不复用机器人 Webhook。</p>
      </div>
      <Button type="button" size="sm" variant="ghost" className="h-9 w-9 shrink-0 p-0" title="读取已绑定飞书会话" aria-label="读取已绑定飞书会话" disabled={busy === 'refresh'} onClick={() => void refresh()}>
        {busy === 'refresh' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      </Button>
    </CardHeader>
    <CardContent className="space-y-3">
      {error && <div className="flex items-start gap-2 border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      {message && !error && <div className="border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">{message}</div>}
      {!targets.length && <div className="border border-dashed border-slate-200 px-3 py-4 text-sm leading-6 text-slate-500">点击刷新读取 QwenPaw 已绑定飞书中出现过的私聊和群聊。首次使用时，先在目标私聊或群聊中向 QwenPaw 发送一条消息。</div>}
      {targets.map((target) => <div key={keyOf(target)} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-slate-100 py-3 last:border-b-0">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-800">{titleOf(target)}</div>
          <div className="mt-1 truncate text-xs text-slate-400">{target.sessionId}</div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-600">
            <label className="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={hasTarget(settings.belowThresholdTargets, target)} onChange={() => setSettings((current) => ({ ...current, belowThresholdTargets: toggle(current.belowThresholdTargets, target) }))} className="h-4 w-4 accent-blue-600" />低价提醒</label>
            <label className="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={hasTarget(settings.loginExpiredTargets, target)} onChange={() => setSettings((current) => ({ ...current, loginExpiredTargets: toggle(current.loginExpiredTargets, target) }))} className="h-4 w-4 accent-blue-600" />账号掉线</label>
          </div>
        </div>
        <Button type="button" size="sm" variant="ghost" className="h-8 w-8 self-start p-0" title="发送测试消息" aria-label={`向 ${titleOf(target)} 发送测试消息`} disabled={busy === `test:${keyOf(target)}`} onClick={() => void test(target)}>
          {busy === `test:${keyOf(target)}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>)}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <span className="text-xs text-slate-500">已选择 {selectedCount} 个提醒目标</span>
        <Button type="button" size="sm" disabled={busy === 'save'} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}保存提醒</Button>
      </div>
    </CardContent>
  </Card>
}
