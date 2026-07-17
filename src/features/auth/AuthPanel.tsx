import { useEffect, useRef, useState } from 'react'
import { Crown, Gift, KeyRound, LoaderCircle, QrCode, RefreshCw, ShieldCheck, Trash2, UserRoundCheck, X } from 'lucide-react'
import { api } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import type { AuthSession } from '../../types/domain'

type Props = {
  sessions: AuthSession[]
  onSaved: () => Promise<void>
  onActivate: (session: AuthSession) => Promise<void>
  onDelete: (session: AuthSession) => Promise<void>
}

export function AuthPanel({ sessions, onSaved, onActivate, onDelete }: Props) {
  const [name, setName] = useState('淘宝扫码账号')
  const [accountType, setAccountType] = useState<'normal' | 'gift' | 'vip88'>('normal')
  const [pendingProfileKey, setPendingProfileKey] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  const checkingScan = useRef(false)
  const accountGroups = [
    { type: 'normal' as const, title: '普通账号', description: '采集正常前台活动价', icon: UserRoundCheck, color: 'sky' },
    { type: 'vip88' as const, title: '88VIP 账号', description: '采集 88VIP 专享价格', icon: Crown, color: 'violet' },
    { type: 'gift' as const, title: '礼金账号', description: '采集首单礼金与新人价格', icon: Gift, color: 'amber' },
  ]

  async function openOAuth() {
    setBusy('scan')
    setMessage('正在打开独立 Chrome 登录窗口...')
    try {
      const result = await api.startTaobaoScan({ name, accountType })
      setPendingProfileKey(result.profileKey)
      setMessage('扫码窗口已打开，登录成功后会自动同步到右侧账号列表。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '打开扫码登录失败。')
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    if (!pendingProfileKey) return undefined
    let cancelled = false
    const check = async () => {
      if (checkingScan.current || cancelled) return
      checkingScan.current = true
      try {
        const result = await api.taobaoScanStatus(pendingProfileKey)
        if (result.status === 'synced' && !cancelled) {
          setPendingProfileKey('')
          setMessage(`${result.session?.name || '淘宝账号'}已授权并同步，账号浏览器已转入后台。`)
          await onSaved()
        } else if (result.status === 'cancelled' && !cancelled) {
          setPendingProfileKey('')
          setMessage('本次账号授权已取消。')
        }
      } catch (error) {
        if (!cancelled) {
          setPendingProfileKey('')
          setMessage(error instanceof Error ? error.message : '自动同步失败，请重新打开扫码登录。')
        }
      } finally {
        checkingScan.current = false
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [pendingProfileKey, onSaved])

  async function cancelScan() {
    const profileKey = pendingProfileKey
    if (!profileKey) return
    setPendingProfileKey('')
    setMessage('正在取消授权并关闭浏览器...')
    try {
      await api.cancelTaobaoScan(profileKey)
      setMessage('本次账号授权已取消，浏览器已关闭。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '取消授权失败。')
    }
  }

  async function checkSession(session: AuthSession) {
    setBusy(`check:${session.id}`)
    setMessage(`正在检测「${session.name}」登录状态...`)
    try {
      const result = await api.checkAuthSession(session.id)
      setMessage(`${session.name}：${result.message}`)
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '账号检测失败。')
    } finally {
      setBusy('')
    }
  }

  async function checkAllSessions() {
    setBusy('check-all')
    setMessage('正在按顺序检测全部扫码账号，不会抓取商品...')
    try {
      const result = await api.checkAllAuthSessions()
      setMessage(`检测完成：在线 ${result.valid} 个，待复检 ${result.degraded} 个，失效 ${result.expired} 个${result.manual ? `，旧 Cookie ${result.manual} 个不参与采价` : ''}。`)
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '一键检测失败。')
    } finally {
      setBusy('')
    }
  }

  async function reauthorizeSession(session: AuthSession) {
    setBusy(`reauth:${session.id}`)
    setMessage(`正在打开「${session.name}」重新授权窗口...`)
    try {
      const result = await api.reauthorizeAuthSession(session.id)
      setPendingProfileKey(result.profileKey)
      setMessage('重新授权窗口已打开，扫码成功后会更新原账号卡片。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '打开重新授权失败。')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="grid gap-5 2xl:grid-cols-[420px_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            添加授权账号
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
        <div className="rounded-md border border-sky-100 bg-sky-50 p-3 text-sm text-sky-900">
          <div className="mb-2 font-medium">扫码授权登录</div>
          <p className="leading-6">每个账号使用独立 Chrome 登录目录。普通、礼金和 88VIP 各自组成账号池，抓取时按健康状态自动轮换。</p>
        </div>
        <div className="grid grid-cols-[1fr_180px] gap-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="账号备注" />
          <select value={accountType} onChange={(event) => setAccountType(event.target.value as 'normal' | 'gift' | 'vip88')} className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700">
            <option value="normal">普通前台账号</option>
            <option value="gift">首单礼金账号</option>
            <option value="vip88">88VIP 账号</option>
          </select>
        </div>
        <div className={pendingProfileKey ? 'grid grid-cols-[1fr_auto] gap-2' : ''}>
          <Button type="button" variant="secondary" className="w-full" onClick={openOAuth} disabled={Boolean(busy) || Boolean(pendingProfileKey)}>
            {pendingProfileKey ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
            {busy === 'scan' ? '打开中' : pendingProfileKey ? '等待扫码，登录后自动同步' : '打开扫码登录'}
          </Button>
          {pendingProfileKey && (
            <Button type="button" variant="danger" onClick={cancelScan} title="取消本次授权并关闭浏览器">
              <X className="h-4 w-4" />
              取消授权
            </Button>
          )}
        </div>
        {message && <p className="text-xs leading-5 text-slate-500">{message}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>已授权登录账号</CardTitle>
            <div className="mt-1 text-sm text-slate-500">{sessions.length} 个账号 · {sessions.filter((session) => session.source === 'taobao-browser' && (session.enabled ?? session.active)).length} 个参与采价</div>
          </div>
          <div className="flex items-center gap-2">
            <Badge>{sessions.filter((session) => session.source === 'taobao-browser').length} 个独立扫码会话</Badge>
            <Button type="button" size="sm" variant="secondary" onClick={checkAllSessions} disabled={Boolean(busy) || Boolean(pendingProfileKey)}>
              <RefreshCw className={`h-4 w-4 ${busy === 'check-all' ? 'animate-spin' : ''}`} />
              {busy === 'check-all' ? '检测中' : '一键检测全部'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 xl:grid-cols-3">
          {accountGroups.flatMap((group) => {
            const groupSessions = sessions.filter((session) => (session.accountType || 'normal') === group.type)
            const cardSessions = groupSessions.length ? groupSessions : [null]
            const Icon = group.icon
            const panelClass = group.color === 'violet' ? 'border-violet-100 bg-violet-50/40' : group.color === 'amber' ? 'border-amber-100 bg-amber-50/40' : 'border-sky-100 bg-sky-50/40'
            const iconClass = group.color === 'violet' ? 'text-violet-600' : group.color === 'amber' ? 'text-amber-600' : 'text-sky-600'
            return cardSessions.map((session) => (
              <section key={session?.id || group.type} className={`min-w-0 rounded-md border p-3 ${panelClass}`}>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <Icon className={`mt-0.5 h-4 w-4 ${iconClass}`} />
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{group.title}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500">{group.description}</div>
                    </div>
                  </div>
                  {session && <Button type="button" size="sm" variant="danger" className="h-8 w-8 shrink-0 p-0" onClick={() => onDelete(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title={`删除账号「${session.name}」`} aria-label={`删除账号「${session.name}」`}><Trash2 className="h-3.5 w-3.5" /></Button>}
                </div>
                {session ? <>
                  <div className="border-t border-white/80 pt-3">
                    <div className="truncate text-sm font-medium text-slate-900">{session.name}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge className="border-slate-200 bg-white/80 text-slate-600">{session.source === 'taobao-browser' ? '独立扫码' : '旧 Cookie'}</Badge>
                      <Badge className={session.source === 'taobao-browser' && (session.enabled ?? session.active) ? '' : 'border-slate-200 bg-white/80 text-slate-500'}>{session.source !== 'taobao-browser' ? '不参与采价' : session.enabled ?? session.active ? '参与采价' : '已停用'}</Badge>
                      <Badge className={session.loginStatus === 'expired' ? 'border-red-100 bg-red-50 text-red-700' : session.loginStatus === 'valid' ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white/80 text-slate-500'}>
                        {session.source !== 'taobao-browser' ? '请删除并改用扫码' : session.loginStatus === 'expired' ? '登录失效' : session.loginStatus === 'valid' ? '已检测在线' : '登录态未检测'}
                      </Badge>
                      <Badge className={session.healthStatus === 'degraded' ? 'border-amber-100 bg-amber-50 text-amber-700' : 'border-emerald-100 bg-emerald-50 text-emerald-700'}>
                        {session.healthStatus === 'degraded' ? '抓取异常' : '账号池健康'}
                      </Badge>
                    </div>
                    {session.lastSuccessAt && <div className="mt-1 text-[11px] text-slate-400">上次成功 {new Date(session.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}</div>}
                    {session.lastCheckedAt && <div className="mt-1 text-[11px] text-slate-400">最后检测 {new Date(session.lastCheckedAt).toLocaleString('zh-CN', { hour12: false })}</div>}
                  </div>
                  {session.source === 'taobao-browser' ? <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/80 pt-3">
                    <Button type="button" size="sm" variant="secondary" onClick={() => checkSession(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="只检测登录状态，不抓取商品">
                      <RefreshCw className={`h-3.5 w-3.5 ${busy === `check:${session.id}` ? 'animate-spin' : ''}`} />
                      {busy === `check:${session.id}` ? '检测中' : '检测登录'}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => reauthorizeSession(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="扫码后更新当前账号，不新增重复卡片">
                      <KeyRound className="h-3.5 w-3.5" />重新授权
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="flex-1" onClick={() => onActivate(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)}>
                      {session.enabled ?? session.active ? '停用采价' : '启用采价'}
                    </Button>
                  </div> : <div className="mt-3 border-t border-white/80 pt-3 text-xs leading-5 text-slate-500">旧 Cookie 无法可靠验证身份，已停止参与价格监控。删除后使用左侧扫码授权。</div>}
                </> : <div className="rounded-md border border-dashed border-slate-200 bg-white/70 px-3 py-8 text-center text-xs text-slate-400">尚未授权</div>}
              </section>
            ))
          })}
        </CardContent>
      </Card>
    </div>
  )
}
