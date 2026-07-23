import { useEffect, useRef, useState } from 'react'
import { Crown, Download, Gift, KeyRound, LoaderCircle, QrCode, RefreshCw, ShieldCheck, Trash2, Upload, UserRoundCheck, X } from 'lucide-react'
import { api } from '../../lib/api'
import { downloadFile } from '../../lib/download'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import type { AuthSession, BrowserEngineId, BrowserEngineOption } from '../../types/domain'

type Props = {
  sessions: AuthSession[]
  onSaved: () => Promise<void>
  onActivate: (session: AuthSession) => Promise<void>
  onDelete: (session: AuthSession) => Promise<void>
}

export function AuthPanel({ sessions, onSaved, onActivate, onDelete }: Props) {
  const [name, setName] = useState('淘宝扫码账号')
  const [accountType, setAccountType] = useState<'normal' | 'gift' | 'vip88'>('normal')
  const [browserEngine, setBrowserEngine] = useState<BrowserEngineId>('uc')
  const [browserEngines, setBrowserEngines] = useState<BrowserEngineOption[]>([])
  const [sessionBrowserEngines, setSessionBrowserEngines] = useState<Record<string, BrowserEngineId>>({})
  const [pendingProfileKey, setPendingProfileKey] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  const [bundleSourceSessionId, setBundleSourceSessionId] = useState('')
  const checkingScan = useRef(false)
  const bundleInputRef = useRef<HTMLInputElement>(null)
  const accountGroups = [
    { type: 'normal' as const, title: '普通账号', icon: UserRoundCheck, color: 'sky' },
    { type: 'vip88' as const, title: '88VIP 账号', icon: Crown, color: 'violet' },
    { type: 'gift' as const, title: '礼金账号', icon: Gift, color: 'amber' },
  ]
  const bundleSourceSessions = sessions.filter((session) => session.source === 'taobao-browser' && session.browserProfileKey && session.browserPort)
  const bundleSourceSession = bundleSourceSessions.find((session) => session.id === bundleSourceSessionId) || bundleSourceSessions[0]

  useEffect(() => {
    let cancelled = false
    void api.browserEngines().then((catalog) => {
      if (cancelled) return
      setBrowserEngines(catalog.engines)
      setBrowserEngine(catalog.defaultEngine)
    }).catch((error) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : '读取浏览器列表失败。')
    })
    return () => { cancelled = true }
  }, [])

  function selectedBrowserForSession(session: AuthSession) {
    const saved = sessionBrowserEngines[session.id] || session.browserEngine
    return browserEngines.some((engine) => engine.id === saved) ? saved as BrowserEngineId : browserEngine
  }

  async function installBrowser(engine: BrowserEngineId) {
    setBusy(`install:${engine}`)
    try {
      const result = await api.installBrowserEngine(engine)
      setMessage(`已打开${result.engine.name}官方下载页；安装完成后返回本页即可选择。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '打开浏览器安装页失败。')
    } finally {
      setBusy('')
    }
  }

  async function openOAuth() {
    setBusy('scan')
    setMessage('正在打开独立账号浏览器...')
    try {
      const selected = browserEngines.find((engine) => engine.id === browserEngine)
      if (selected && !selected.available) {
        await installBrowser(browserEngine)
        return
      }
      const result = await api.startTaobaoScan({ name, accountType, browserEngine })
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
    setMessage(`正在检测「${session.name}」的登录状态...`)
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
    setMessage('正在按顺序检测全部账号的登录状态，不会打开商品页...')
    try {
      const result = await api.checkAllAuthSessions()
      setMessage(`检测完成：淘宝身份在线 ${result.identityOnline} 个，其中天猫查价可用 ${result.priceUsable} 个、待验证或异常 ${result.priceUnavailable} 个；登录失效 ${result.expired} 个${result.manual ? `，旧 Cookie ${result.manual} 个不参与采价` : ''}。`)
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '一键检测失败。')
    } finally {
      setBusy('')
    }
  }

  async function reauthorizeSession(session: AuthSession) {
    const selectedEngine = selectedBrowserForSession(session)
    const selected = browserEngines.find((engine) => engine.id === selectedEngine)
    if (selected && !selected.available) {
      await installBrowser(selectedEngine)
      return
    }
    setBusy(`reauth:${session.id}`)
    setMessage(`正在打开「${session.name}」重新授权窗口...`)
    try {
      const result = await api.reauthorizeAuthSession(session.id, selectedEngine)
      setPendingProfileKey(result.profileKey)
      setMessage('重新授权窗口已打开，扫码成功后会更新原账号卡片。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '处理账号授权状态失败。')
    } finally {
      setBusy('')
    }
  }

  async function exportLoginBundle(session: AuthSession) {
    setBusy(`export:${session.id}`)
    setMessage(`正在加密导出「${session.name}」的登录包...`)
    try {
      const result = await downloadFile(`/api/auth/sessions/${encodeURIComponent(session.id)}/login-bundle`, `${session.name}_登录包.json`)
      setMessage(`登录包已导出：${result.filename}。它只能在本机当前应用数据下导入，请妥善保管。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导出登录包失败。')
    } finally {
      setBusy('')
    }
  }

  async function importLoginBundle(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      setMessage('登录包不能超过 2MB。')
      return
    }
    setBusy('import-bundle')
    setMessage('正在解密登录包、写入独立浏览器并验证登录状态...')
    try {
      const result = await api.importAuthLoginBundle(file, browserEngine)
      setMessage(result.message)
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导入登录包失败。')
    } finally {
      setBusy('')
      if (bundleInputRef.current) bundleInputRef.current.value = ''
    }
  }

  return (
    <div className="auth-panel grid min-w-0 gap-5">
      <input ref={bundleInputRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => {
        const file = event.target.files?.[0]
        if (file) void importLoginBundle(file)
      }} />
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
          <p className="leading-6">默认使用 UC 浏览器，每个账号保存独立登录目录。登录成功后可导出本机加密 JSON 登录包，后续导入即可自动恢复；失效 Cookie 不会创建账号。</p>
          <p className="mt-1 leading-6 text-sky-700">普通商品页链接不包含登录 Cookie，不能靠粘贴链接生成登录包；已经在本应用账号浏览器登录的账号，可在下方“已授权登录账号”区直接一键生成。</p>
        </div>
        <div className="auth-account-form-fields grid gap-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="账号备注" />
          <select value={accountType} onChange={(event) => setAccountType(event.target.value as 'normal' | 'gift' | 'vip88')} className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700">
            <option value="normal">普通前台账号</option>
            <option value="gift">首单礼金账号</option>
            <option value="vip88">88VIP 账号</option>
          </select>
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-slate-200 bg-white p-1.5">
          <select value={browserEngine} onChange={(event) => setBrowserEngine(event.target.value as BrowserEngineId)} className="h-8 min-w-0 flex-1 rounded border-0 bg-transparent px-2 text-sm text-slate-800 outline-none">
            {browserEngines.map((engine) => <option key={engine.id} value={engine.id}>{engine.name}{engine.available ? ' · 已安装' : ' · 未安装'}</option>)}
          </select>
          {browserEngines.find((engine) => engine.id === browserEngine && !engine.available) && (
            <Button type="button" size="sm" variant="secondary" className="h-8 shrink-0" onClick={() => installBrowser(browserEngine)} disabled={Boolean(busy)}><Download className="h-3.5 w-3.5" />安装</Button>
          )}
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
            <div className="mt-1 text-sm text-slate-500">{sessions.length} 个账号 · {sessions.filter((session) => session.identityOnline && (session.enabled ?? session.active)).length} 个淘宝在线 · {sessions.filter((session) => session.priceUsable && (session.enabled ?? session.active)).length} 个查价可用</div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {bundleSourceSession && (
              <div className="flex min-w-0 items-center gap-1 rounded-md border border-slate-200 bg-white p-1">
                <select value={bundleSourceSession.id} onChange={(event) => setBundleSourceSessionId(event.target.value)} className="h-7 max-w-40 min-w-0 rounded border-0 bg-transparent px-1.5 text-xs text-slate-700 outline-none" title="选择一个本应用已授权账号">
                  {bundleSourceSessions.map((session) => <option key={session.id} value={session.id}>{session.name}</option>)}
                </select>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => exportLoginBundle(bundleSourceSession)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="从这个已登录账号直接生成本机加密 JSON 登录包">
                  <Download className="h-3.5 w-3.5" />
                  {busy === `export:${bundleSourceSession.id}` ? '生成中' : '生成登录包'}
                </Button>
              </div>
            )}
            <Button type="button" size="sm" variant="secondary" onClick={() => bundleInputRef.current?.click()} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="选择本机导出的加密 JSON 登录包">
              {busy === 'import-bundle' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {busy === 'import-bundle' ? '导入验证中' : '导入登录包'}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={checkAllSessions} disabled={Boolean(busy) || Boolean(pendingProfileKey)}>
              <RefreshCw className={`h-4 w-4 ${busy === 'check-all' ? 'animate-spin' : ''}`} />
              {busy === 'check-all' ? '检测中' : '一键检测全部'}
            </Button>
          </div>
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
              const identityLabel = session.loginStatus === 'valid' ? '淘宝在线' : session.loginStatus === 'expired' ? '淘宝失效' : '身份待检测'
              const priceLabel = session.availabilityStatus === 'access-restricted'
                ? '浏览器受限'
                : session.tmallPriceStatus === 'valid'
                  ? '天猫查价可用'
                  : session.tmallPriceStatus === 'degraded'
                    ? '天猫查价异常'
                    : '天猫查价待验证'
              const selectedSessionEngine = selectedBrowserForSession(session)
              return (
                <section key={session.id} className={`min-w-0 rounded-md border p-2.5 ${panelClass}`}>
                  <div className="flex items-start gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/80"><Icon className={`h-3.5 w-3.5 ${iconClass}`} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-semibold text-slate-950" title={session.name}>{session.name}</span><span className="shrink-0 text-[11px] text-slate-500">{group.title}</span></div>
                      <div className="mt-1 flex flex-wrap gap-1 text-[11px] font-medium">
                        <span title={checkedTitle} className={`inline-flex items-center rounded px-1.5 py-0.5 ${session.loginStatus === 'valid' ? 'bg-emerald-100 text-emerald-800' : session.loginStatus === 'expired' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{session.source !== 'taobao-browser' ? '旧 Cookie' : identityLabel}</span>
                        {session.source === 'taobao-browser' && <span title={session.availabilityReason || checkedTitle} className={`inline-flex items-center rounded px-1.5 py-0.5 ${session.priceUsable ? 'bg-blue-100 text-blue-800' : session.tmallPriceStatus === 'degraded' || session.availabilityStatus === 'access-restricted' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{priceLabel}</span>}
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 ${session.enabled ?? session.active ? 'bg-blue-50 text-blue-700' : 'bg-white/80 text-slate-500'}`}>{session.enabled ?? session.active ? '参与采价' : '已停用'}</span>
                      </div>
                    </div>
                    <Button type="button" size="sm" variant="danger" className="h-7 w-7 shrink-0 p-0" onClick={() => onDelete(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title={`删除账号「${session.name}」`} aria-label={`删除账号「${session.name}」`}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>

                  {session.source === 'taobao-browser' ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-white/80 pt-1.5">
                      <select value={selectedSessionEngine} onChange={(event) => setSessionBrowserEngines((current) => ({ ...current, [session.id]: event.target.value as BrowserEngineId }))} className="h-7 max-w-32 rounded border border-white bg-white/80 px-1.5 text-xs text-slate-700" title="切换后点击重新授权，将使用新的独立浏览器资料">
                        {browserEngines.map((engine) => <option key={engine.id} value={engine.id}>{engine.name}{engine.available ? '' : '（未安装）'}</option>)}
                      </select>
                      <Button type="button" size="sm" variant="secondary" className="h-7 px-2" onClick={() => checkSession(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="只读取账号浏览器现有登录状态，不打开商品页"><RefreshCw className={`h-3.5 w-3.5 ${busy === `check:${session.id}` ? 'animate-spin' : ''}`} />{busy === `check:${session.id}` ? '检测中' : '检测登录'}</Button>
                      <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => reauthorizeSession(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="扫码后更新当前账号，不新增重复卡片"><KeyRound className="h-3.5 w-3.5" />{busy === `reauth:${session.id}` ? '打开中' : '重新授权'}</Button>
                      <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => exportLoginBundle(session)} disabled={Boolean(busy) || Boolean(pendingProfileKey)} title="导出本机加密 JSON 登录包"><Download className="h-3.5 w-3.5" />{busy === `export:${session.id}` ? '导出中' : '导出登录包'}</Button>
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
