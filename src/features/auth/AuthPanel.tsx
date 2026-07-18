import { useEffect, useRef, useState } from 'react'
import { Crown, Gift, KeyRound, LoaderCircle, QrCode, RefreshCw, ShieldCheck, Trash2, UserRoundCheck, X } from 'lucide-react'
import { api } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
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
    { type: 'normal' as const, title: '普通账号', icon: UserRoundCheck, color: 'sky' },
    { type: 'vip88' as const, title: '88VIP 账号', icon: Crown, color: 'violet' },
    { type: 'gift' as const, title: '礼金账号', icon: Gift, color: 'amber' },
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
          setMessage(`${result.session?.name || '淘宝账号'}的淘宝登录已同步；天猫价格能力将在首次真实商品抓取后确认。`)
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
    <div className="auth-panel grid min-w-0 gap-5">
      <Card className="min-w-0">
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
        <div className="auth-account-form-fields grid gap-2">
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

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>已授权登录账号</CardTitle>
            <div className="mt-1 text-sm text-slate-500">{sessions.length} 个账号 · {sessions.filter((session) => session.source === 'taobao-browser' && (session.enabled ?? session.active)).length} 个参与采价</div>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={checkAllSessions} disabled={Boolean(busy) || Boolean(pendingProfileKey)}>
            <RefreshCw className={`h-4 w-4 ${busy === 'check-all' ? 'animate-spin' : ''}`} />
            {busy === 'check-all' ? '检测中' : '一键检测全部'}
          </Button>
        </CardHeader>
        <CardContent className="min-w-0">
          <div className="auth-session-grid grid min-w-0 items-start gap-2">
            {sessions.map((session) => {
              const group = accountGroups.find((item) => item.type === (session.accountType || 'normal')) || accountGroups[0]
              const Icon = group.icon
              const panelClass = group.color === 'violet' ? 'border-violet-100 bg-violet-50/35' : group.color === 'amber' ? 'border-amber-100 bg-amber-50/35' : 'border-sky-100 bg-sky-50/35'
              const iconClass = group.color === 'violet' ? 'text-violet-600' : group.color === 'amber' ? 'text-amber-600' : 'text-sky-600'
              const checkedAt = session.lastCheckedAt || session.lastSuccessAt
              const checkedTitle = checkedAt ? `最近检测 ${new Date(checkedAt).toLocaleString('zh-CN', { hour12: false })}` : '尚未检测登录状态'
              return (
                <section key={session.id} className={`min-w-0 rounded-md border p-2.5 ${panelClass}`}>
                  <div className="flex items-start gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/80"><Icon className={`h-3.5 w-3.5 ${iconClass}`} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-semibold text-slate-950" title={session.name}>{session.name}</span><span className="shrink-0 text-[11px] text-slate-500">{group.title}</span></div>
                      <div className="mt-1 flex flex-wrap gap-1 text-[11px] font-medium">
                        <span title={checkedTitle} className={`inline-flex items-center rounded px-1.5 py-0.5 ${session.loginStatus === 'expired' ? 'bg-red-50 text-red-700' : session.loginStatus === 'valid' ? 'bg-emerald-50 text-emerald-700' : 'bg-white/80 text-slate-500'}`}>{session.source !== 'taobao-browser' ? '旧 Cookie' : session.loginStatus === 'expired' ? '登录失效' : session.loginStatus === 'valid' ? '在线' : '未检测'}</span>
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 ${session.source === 'taobao-browser' && (session.enabled ?? session.active) ? 'bg-blue-50 text-blue-700' : 'bg-white/80 text-slate-500'}`}>{session.source === 'taobao-browser' && (session.enabled ?? session.active) ? '采价中' : '已停用'}</span>
                        {session.source === 'taobao-browser' && <span className={`inline-flex items-center rounded px-1.5 py-0.5 ${session.tmallPriceStatus === 'valid' ? 'bg-emerald-50 text-emerald-700' : session.tmallPriceStatus === 'cooldown' ? 'bg-amber-50 text-amber-700' : 'bg-white/80 text-slate-500'}`}>{session.tmallPriceStatus === 'valid' ? '价格已验证' : session.tmallPriceStatus === 'cooldown' ? '价格冷却' : '价格待验证'}</span>}
                        {session.healthStatus === 'degraded' && <span className="inline-flex items-center rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">抓取异常</span>}
                      </div>
                    </div>
                    <Button type="button" size="sm" variant="danger" className="h-7 w-7 shrink-0 p-0" onClick={() => onDelete(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title={`删除账号「${session.name}」`} aria-label={`删除账号「${session.name}」`}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>

                  {session.source === 'taobao-browser' ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-white/80 pt-1.5">
                      <Button type="button" size="sm" variant="secondary" className="h-7 px-2" onClick={() => checkSession(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="只检测登录状态，不抓取商品"><RefreshCw className={`h-3.5 w-3.5 ${busy === `check:${session.id}` ? 'animate-spin' : ''}`} />{busy === `check:${session.id}` ? '检测中' : '检测'}</Button>
                      <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => reauthorizeSession(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="扫码后更新当前账号，不新增重复卡片"><KeyRound className="h-3.5 w-3.5" />重新授权</Button>
                      <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 px-2" onClick={() => onActivate(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)}>{session.enabled ?? session.active ? '停用' : '启用'}</Button>
                    </div>
                  ) : <div className="mt-1.5 border-t border-white/80 pt-1.5 text-xs text-slate-500">旧 Cookie 不参与价格监控，请删除后改用扫码授权。</div>}
                </section>
              )
            })}
            {sessions.length === 0 && <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">还没有授权账号，请先在上方打开扫码登录。</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
