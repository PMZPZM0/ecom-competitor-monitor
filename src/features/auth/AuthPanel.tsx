import { useEffect, useRef, useState } from 'react'
import { CircleHelp, Cookie, Crown, Gift, KeyRound, LoaderCircle, QrCode, RefreshCw, ShieldCheck, TimerReset, UserRoundCheck, X } from 'lucide-react'
import { api } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input, Textarea } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import type { AuthSession, Overview } from '../../types/domain'

type Props = {
  sessions: AuthSession[]
  onSaved: () => Promise<void>
  onActivate: (session: AuthSession) => Promise<void>
  onDelete: (session: AuthSession) => Promise<void>
  monitor: Overview['monitor']
}

const protectionPresets = [1, 3, 5, 10, 30]
type AccountType = 'normal' | 'gift' | 'vip88'

function poolProtectionChoice(value?: number | null) {
  if (value == null) return 'global'
  if (value === 0) return 'off'
  return protectionPresets.includes(value) ? String(value) : 'custom'
}

function globalProtectionChoice(value: number) {
  if (value === 0) return 'off'
  return protectionPresets.includes(value) ? String(value) : 'custom'
}

export function AuthPanel({ sessions, onSaved, onActivate, onDelete, monitor }: Props) {
  const [name, setName] = useState('淘宝扫码账号')
  const [accountType, setAccountType] = useState<'normal' | 'gift' | 'vip88'>('normal')
  const [cookie, setCookie] = useState('')
  const [pendingProfileKey, setPendingProfileKey] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  const [protectionChoice, setProtectionChoice] = useState(() => globalProtectionChoice(monitor.captureProtectionMinutes))
  const [customProtectionMinutes, setCustomProtectionMinutes] = useState(() => String(monitor.captureProtectionMinutes > 0 ? monitor.captureProtectionMinutes : 3))
  const [poolProtectionChoices, setPoolProtectionChoices] = useState<Record<AccountType, string>>(() => ({
    normal: poolProtectionChoice(monitor.captureProtectionByAccount?.normal),
    vip88: poolProtectionChoice(monitor.captureProtectionByAccount?.vip88),
    gift: poolProtectionChoice(monitor.captureProtectionByAccount?.gift),
  }))
  const [poolCustomMinutes, setPoolCustomMinutes] = useState<Record<AccountType, string>>(() => ({
    normal: String((monitor.captureProtectionByAccount?.normal ?? monitor.captureProtectionMinutes) || 3),
    vip88: String((monitor.captureProtectionByAccount?.vip88 ?? monitor.captureProtectionMinutes) || 3),
    gift: String((monitor.captureProtectionByAccount?.gift ?? monitor.captureProtectionMinutes) || 3),
  }))
  const checkingScan = useRef(false)
  const accountGroups = [
    { type: 'normal' as const, title: '普通账号', description: '采集正常前台活动价', icon: UserRoundCheck, color: 'sky' },
    { type: 'vip88' as const, title: '88VIP 账号', description: '采集 88VIP 专享价格', icon: Crown, color: 'violet' },
    { type: 'gift' as const, title: '礼金账号', description: '采集首单礼金与新人价格', icon: Gift, color: 'amber' },
  ]

  useEffect(() => {
    const minutes = monitor.captureProtectionMinutes
    setProtectionChoice(globalProtectionChoice(minutes))
    setCustomProtectionMinutes(String(minutes > 0 ? minutes : 3))
  }, [monitor.captureProtectionMinutes])

  useEffect(() => {
    const overrides = monitor.captureProtectionByAccount || {}
    setPoolProtectionChoices({
      normal: poolProtectionChoice(overrides.normal),
      vip88: poolProtectionChoice(overrides.vip88),
      gift: poolProtectionChoice(overrides.gift),
    })
    setPoolCustomMinutes({
      normal: String((overrides.normal ?? monitor.captureProtectionMinutes) || 3),
      vip88: String((overrides.vip88 ?? monitor.captureProtectionMinutes) || 3),
      gift: String((overrides.gift ?? monitor.captureProtectionMinutes) || 3),
    })
  }, [monitor.captureProtectionByAccount, monitor.captureProtectionMinutes])

  async function saveProtectionMinutes() {
    const minutes = protectionChoice === 'off' ? 0 : protectionChoice === 'custom' ? Number(customProtectionMinutes) : Number(protectionChoice)
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 120 || (protectionChoice === 'custom' && minutes < 1)) {
      setMessage('本地采集保护时间必须是 1 到 120 分钟的整数。')
      return
    }
    setBusy('protection')
    try {
      await api.updateMonitor({ captureProtectionMinutes: minutes })
      setMessage(minutes === 0 ? '本地采集保护已关闭，抓取失败时不会进入软件倒计时。' : `本地采集保护时间已设为 ${minutes} 分钟。此设置只控制软件抓取频率，不代表淘宝账号风控。`)
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存采集保护时间失败。')
    } finally {
      setBusy('')
    }
  }

  async function savePoolProtectionMinutes(type: AccountType) {
    const choice = poolProtectionChoices[type]
    const minutes = choice === 'global' ? null : choice === 'off' ? 0 : choice === 'custom' ? Number(poolCustomMinutes[type]) : Number(choice)
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 120 || (choice === 'custom' && minutes < 1))) {
      setMessage('账号池采集保护时间必须是 1 到 120 分钟的整数。')
      return
    }
    setBusy(`protection:${type}`)
    try {
      await api.updateMonitor({ captureProtectionByAccount: { [type]: minutes } })
      const groupName = type === 'gift' ? '礼金账号池' : type === 'vip88' ? '88VIP 账号池' : '普通账号池'
      setMessage(minutes === null ? `${groupName}已改为跟随全局采集保护时间。` : minutes === 0 ? `${groupName}已单独关闭本地采集保护。` : `${groupName}采集保护时间已设为 ${minutes} 分钟。`)
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存账号池采集保护时间失败。')
    } finally {
      setBusy('')
    }
  }

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
          setMessage(`${result.session?.name || '淘宝账号'}已授权并同步，扫码浏览器已自动关闭。`)
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

  async function saveCookie(event: React.FormEvent) {
    event.preventDefault()
    setBusy('cookie')
    setMessage('正在保存 Cookie 会话...')
    try {
      await api.addAuthSession({ name, cookie, accountType })
      setCookie('')
      setMessage('会话已保存，后续抓取会带上该 Cookie。')
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存 Cookie 会话失败。')
    } finally {
      setBusy('')
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
      setMessage(`检测完成：在线 ${result.valid} 个，失效 ${result.expired} 个，手动 Cookie ${result.manual} 个。`)
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '一键检测失败。')
    } finally {
      setBusy('')
    }
  }

  async function releaseCooldown(session: AuthSession) {
    setBusy(`release:${session.id}`)
    setMessage(`正在解除「${session.name}」的采价冷却...`)
    try {
      await api.releaseAuthSessionCooldown(session.id)
      setMessage(`${session.name}：本地采集保护已解除，可以立即重新抓取。`)
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '解除冷却失败。')
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
        <div className="border-y border-slate-100 py-3">
          <div className="mb-2 text-sm font-medium text-slate-700">本地采集保护时间</div>
          <div className="grid grid-cols-[minmax(0,1fr)_120px_auto] gap-2">
            <select value={protectionChoice} onChange={(event) => setProtectionChoice(event.target.value)} className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700" aria-label="采集保护时间">
              <option value="off">关闭保护</option>
              {protectionPresets.map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
              <option value="custom">自定义</option>
            </select>
            <Input type="number" min="1" max="120" step="1" value={customProtectionMinutes} onChange={(event) => setCustomProtectionMinutes(event.target.value)} disabled={protectionChoice !== 'custom'} aria-label="自定义采集保护分钟数" />
            <Button type="button" variant="secondary" onClick={saveProtectionMinutes} disabled={Boolean(busy)}>{busy === 'protection' ? '保存中' : '保存'}</Button>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-slate-500">仅控制本软件连续访问频率，可关闭。出现倒计时不代表淘宝账号被风控，倒计时结束后抓取按钮自动恢复。</p>
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
        <form className="space-y-3" onSubmit={saveCookie}>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <Cookie className="h-4 w-4 text-emerald-600" />
            手动 Cookie 兜底
          </div>
          <Textarea value={cookie} onChange={(event) => setCookie(event.target.value)} placeholder="粘贴已登录淘宝账号 Cookie，用于本地抓取请求" required />
          <Button type="submit" className="w-full" disabled={Boolean(busy)}>
            {busy === 'cookie' ? '保存中' : '保存本地会话'}
          </Button>
        </form>
        {message && <p className="text-xs leading-5 text-slate-500">{message}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>已授权登录账号</CardTitle>
            <div className="mt-1 text-sm text-slate-500">{sessions.length} 个账号 · {sessions.filter((session) => session.enabled ?? session.active).length} 个参与采价</div>
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
          {accountGroups.map((group) => {
            const groupSessions = sessions.filter((session) => (session.accountType || 'normal') === group.type)
            const Icon = group.icon
            const panelClass = group.color === 'violet' ? 'border-violet-100 bg-violet-50/40' : group.color === 'amber' ? 'border-amber-100 bg-amber-50/40' : 'border-sky-100 bg-sky-50/40'
            const iconClass = group.color === 'violet' ? 'text-violet-600' : group.color === 'amber' ? 'text-amber-600' : 'text-sky-600'
            return (
              <section key={group.type} className={`min-w-0 rounded-md border p-3 ${panelClass}`}>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <Icon className={`mt-0.5 h-4 w-4 ${iconClass}`} />
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{group.title}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500">{group.description}</div>
                    </div>
                  </div>
                  <Badge className="shrink-0 bg-white">{groupSessions.length} 个</Badge>
                </div>
                <div className="mb-3 grid grid-cols-[minmax(0,1fr)_74px_auto] gap-1.5" title="仅控制本软件访问频率，不代表淘宝账号风控">
                  <select
                    value={poolProtectionChoices[group.type]}
                    onChange={(event) => setPoolProtectionChoices((current) => ({ ...current, [group.type]: event.target.value }))}
                    className="h-8 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
                    aria-label={`${group.title}采集保护时间`}
                  >
                    <option value="global">跟随全局</option>
                    <option value="off">关闭保护</option>
                    {protectionPresets.map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
                    <option value="custom">自定义</option>
                  </select>
                  <Input
                    className="h-8 px-2 text-xs"
                    type="number"
                    min="1"
                    max="120"
                    step="1"
                    value={poolCustomMinutes[group.type]}
                    onChange={(event) => setPoolCustomMinutes((current) => ({ ...current, [group.type]: event.target.value }))}
                    disabled={poolProtectionChoices[group.type] !== 'custom'}
                    aria-label={`${group.title}自定义采集保护分钟数`}
                  />
                  <Button type="button" size="sm" variant="secondary" onClick={() => savePoolProtectionMinutes(group.type)} disabled={Boolean(busy)}>
                    {busy === `protection:${group.type}` ? '保存中' : '保存'}
                  </Button>
                </div>
                <div className="space-y-2">
                  {groupSessions.map((session) => (
                    <div key={session.id} className="rounded-md border border-white bg-white p-2.5 shadow-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900">{session.name}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Badge className="border-slate-200 bg-slate-50 text-slate-600">{session.source === 'taobao-browser' ? '独立扫码' : 'Cookie'}</Badge>
                            <Badge className={session.enabled ?? session.active ? '' : 'border-slate-200 bg-slate-50 text-slate-500'}>{session.enabled ?? session.active ? '参与采价' : '已停用'}</Badge>
                            <Badge className={session.loginStatus === 'expired' ? 'border-red-100 bg-red-50 text-red-700' : session.loginStatus === 'valid' ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}>
                              {session.source !== 'taobao-browser' ? 'Cookie 待实际验证' : session.loginStatus === 'expired' ? '登录失效' : session.loginStatus === 'valid' ? '已检测在线' : '登录态未检测'}
                            </Badge>
                            <Badge className={session.healthStatus === 'cooldown' ? 'border-red-100 bg-red-50 text-red-700' : session.healthStatus === 'degraded' ? 'border-amber-100 bg-amber-50 text-amber-700' : 'border-emerald-100 bg-emerald-50 text-emerald-700'}>
                              {session.healthStatus === 'cooldown' ? '本地采集保护' : session.healthStatus === 'degraded' ? '抓取异常' : '账号池健康'}
                            </Badge>
                          </div>
                          {session.cooldownUntil && new Date(session.cooldownUntil).getTime() > Date.now() && <div className="mt-1 text-[11px] leading-4 text-amber-600">软件采集保护至 {new Date(session.cooldownUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}。这是本地访问频率控制，不代表淘宝账号被风控；期间会自动切换其他账号。</div>}
                          {session.lastSuccessAt && <div className="mt-1 text-[11px] text-slate-400">上次成功 {new Date(session.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}</div>}
                          {session.lastCheckedAt && <div className="mt-1 text-[11px] text-slate-400">最后检测 {new Date(session.lastCheckedAt).toLocaleString('zh-CN', { hour12: false })}</div>}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-100 pt-2">
                        <Button type="button" size="sm" variant="secondary" onClick={() => checkSession(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="只检测登录状态，不抓取商品">
                          <RefreshCw className={`h-3.5 w-3.5 ${busy === `check:${session.id}` ? 'animate-spin' : ''}`} />
                          {busy === `check:${session.id}` ? '检测中' : '检测登录'}
                        </Button>
                        {session.cooldownUntil && new Date(session.cooldownUntil).getTime() > Date.now() && (
                          <Button type="button" size="sm" variant="ghost" onClick={() => releaseCooldown(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="登录未失效时手动恢复采价；再次触发验证会进入逐级冷却">
                            <TimerReset className="h-3.5 w-3.5" />{busy === `release:${session.id}` ? '解除中' : '解除采集保护'}
                          </Button>
                        )}
                        <Button type="button" size="sm" variant="ghost" onClick={() => reauthorizeSession(session)} disabled={session.source !== 'taobao-browser' || Boolean(busy) || Boolean(pendingProfileKey)} title={session.source === 'taobao-browser' ? '扫码后更新当前账号，不新增重复卡片' : '手动 Cookie 账号请在左侧重新粘贴 Cookie'}>
                          <KeyRound className="h-3.5 w-3.5" />重新授权
                        </Button>
                        <Button type="button" size="sm" variant="ghost" className="flex-1" onClick={() => onActivate(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)}>
                          {session.enabled ?? session.active ? '停用采价' : '启用采价'}
                        </Button>
                        <Button type="button" size="sm" variant="danger" onClick={() => onDelete(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)}>删除</Button>
                      </div>
                    </div>
                  ))}
                  {groupSessions.length === 0 && <div className="rounded-md border border-dashed border-slate-200 bg-white/70 px-3 py-8 text-center text-xs text-slate-400">尚未授权</div>}
                </div>
              </section>
            )
          })}
        </CardContent>
      </Card>
      <details className="group rounded-md border border-slate-200 bg-white 2xl:col-span-2">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50">
          <CircleHelp className="h-4 w-4 text-sky-600" />
          采集策略使用说明
          <span className="ml-auto text-xs font-normal text-slate-400 group-open:hidden">展开查看</span>
          <span className="ml-auto hidden text-xs font-normal text-slate-400 group-open:inline">收起</span>
        </summary>
        <div className="grid border-t border-slate-100 md:grid-cols-2 xl:grid-cols-4">
          <div className="p-4 xl:border-r xl:border-slate-100">
            <div className="text-xs font-semibold text-slate-800">为什么需要保护</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">避免同一账号在短时间内连续访问商品页，降低频繁请求造成登录验证或访问异常的概率。这是本软件的访问间隔，不是淘宝风控状态。</p>
            <p className="mt-2 text-xs leading-5 text-slate-500">采集标签抓完立即关闭；后台账号浏览器空闲 20 秒后自动退出。账号登录目录和 Cookie 会保留，关闭进程不等于退出淘宝账号。</p>
          </div>
          <div className="border-t border-slate-100 p-4 md:border-l md:border-t-0 md:border-slate-100 xl:border-l-0 xl:border-r">
            <div className="text-xs font-semibold text-slate-800">单个商品抓取</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">遵守对应账号池的保护时间。池内全部账号都在倒计时时，抓取按钮显示剩余时间；关闭保护后可连续手动抓取。</p>
          </div>
          <div className="border-t border-slate-100 p-4 xl:border-r xl:border-t-0">
            <div className="text-xs font-semibold text-slate-800">批量抓取</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">同一账号严格按顺序抓取，不同账号自动并行，调度上限为 5 个。批量任务跳过本地保护倒计时，但不会绕过淘宝登录验证、滑块或访问限制。</p>
          </div>
          <div className="border-t border-slate-100 p-4 md:border-l md:border-slate-100 xl:border-l-0 xl:border-t-0">
            <div className="text-xs font-semibold text-slate-800">自动监控</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">同一账号严格按顺序抓取，不同账号自动并行，调度上限为 5 个，并遵守对应账号池的保护时间。关闭保护只取消本地倒计时，不会取消账号隔离。</p>
          </div>
        </div>
      </details>
    </div>
  )
}
