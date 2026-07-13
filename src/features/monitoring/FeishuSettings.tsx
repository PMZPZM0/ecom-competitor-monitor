import { BellRing, BookOpen, CheckCircle2, ExternalLink, QrCode, RefreshCw, Save, Send, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { timeAgo } from '../../lib/utils'
import { api } from '../../lib/api'
import type { LarkCliStatus, Overview, Product } from '../../types/domain'

type Props = {
  feishu: Overview['feishu']
  logs: Overview['notificationLogs']
  products: Product[]
  onSave: (payload: { enabled?: boolean; webhookUrl?: string; signingSecret?: string; clearSigningSecret?: boolean; cooldownEnabled?: boolean; cooldownMinutes?: number; documentEnabled?: boolean }) => Promise<void>
  onTest: () => Promise<void>
}

type FeishuAuthorizationProps = Pick<Props, 'feishu' | 'products' | 'onSave'>

export function FeishuAuthorization({ feishu, products, onSave }: FeishuAuthorizationProps) {
  const [cli, setCli] = useState<LarkCliStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const refreshCli = () => api.larkCliStatus().then((status) => { if (active) setCli(status) }).catch(() => undefined)
    refreshCli()
    const timer = window.setInterval(refreshCli, 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  async function start(action: 'setup' | 'login' | 'document') {
    setBusy(true)
    try {
      if (action === 'setup') await api.startLarkCliSetup()
      if (action === 'login') await api.startLarkCliLogin()
      if (action === 'document') await api.createFeishuDocument()
      setCli(await api.larkCliStatus())
      if (action === 'document') window.location.reload()
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><QrCode className="h-4 w-4 text-sky-600" />飞书授权与文档</CardTitle><div className="mt-1 text-sm text-slate-500">扫码授权飞书云空间，自动创建并持续写入 SKU 价格文档。</div></CardHeader>
      <CardContent className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-md border border-sky-100 bg-sky-50 p-3">
          <div className="flex items-center justify-between"><div className="text-sm font-semibold text-sky-900">飞书扫码授权</div><span className="text-[11px] text-sky-600">CLI {cli?.version || '检测中'}</span></div>
          <div className="mt-2 text-xs leading-5 text-sky-700">官方 CLI 管理授权令牌，本软件不读取令牌。</div>
          <div className="mt-3 flex items-center gap-2">
            {!cli?.configured && <Button size="sm" variant="secondary" onClick={() => start('setup')} disabled={busy}><ExternalLink className="h-3.5 w-3.5" />创建飞书应用</Button>}
            {cli?.configured && !cli.authenticated && <Button size="sm" variant="secondary" onClick={() => start('login')} disabled={busy}><QrCode className="h-3.5 w-3.5" />扫码授权</Button>}
            {cli?.authenticated && <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />授权有效</span>}
            <button type="button" onClick={() => api.larkCliStatus().then(setCli)} className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded text-sky-600 hover:bg-sky-100" title="刷新授权状态"><RefreshCw className="h-3.5 w-3.5" /></button>
          </div>
          {cli?.setup.url && cli.setup.status === 'running' && <a href={cli.setup.url} target="_blank" rel="noreferrer" className="mt-2 block truncate text-xs text-sky-700 underline">打开飞书开放平台</a>}
          {cli?.login.status === 'waiting' && <div className="mt-3 flex gap-3 rounded border border-white bg-white p-2"><img src={`/api/feishu/cli/qrcode?t=${cli.login.startedAt}`} alt="飞书授权二维码" className="h-28 w-28" /><div className="self-center text-xs text-slate-600"><div className="font-medium text-slate-800">使用飞书扫码确认</div><a href={cli.login.url} target="_blank" rel="noreferrer" className="mt-1 block text-sky-700 underline">打开授权链接</a></div></div>}
          {(cli?.login.message || cli?.setup.message || cli?.userMessage) && <div className="mt-2 text-[11px] text-slate-500">{cli?.login.message || cli?.setup.message || cli?.userMessage}</div>}
        </section>
        <section className="rounded-md border border-violet-100 bg-violet-50 p-3">
          <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold text-violet-900"><BookOpen className="h-4 w-4" />价格监控文档</div>{feishu.documentConfigured && <span className="text-[11px] text-emerald-700">已创建</span>}</div>
          <div className="mt-2 text-xs leading-5 text-violet-700">当前 {products.length} 个商品，抓取后按店铺、型号和 SKU 自动追加。</div>
          <div className="mt-3 flex items-center gap-2">
            {!feishu.documentConfigured ? <Button size="sm" variant="secondary" onClick={() => start('document')} disabled={busy || !cli?.authenticated || products.length === 0}><BookOpen className="h-3.5 w-3.5" />创建价格文档</Button> : <button type="button" role="switch" aria-checked={feishu.documentEnabled} onClick={() => onSave({ documentEnabled: !feishu.documentEnabled })} className="inline-flex items-center gap-2 text-xs text-violet-800">自动写入<span className={`relative h-5 w-9 rounded-full ${feishu.documentEnabled ? 'bg-violet-600' : 'bg-slate-200'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow ${feishu.documentEnabled ? 'left-[18px]' : 'left-0.5'}`} /></span></button>}
            {feishu.documentUrl && <a href={feishu.documentUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-violet-700">打开文档 <ExternalLink className="h-3 w-3" /></a>}
          </div>
          {feishu.lastDocumentSyncAt && <div className="mt-2 text-[11px] text-violet-500">最近写入 {timeAgo(feishu.lastDocumentSyncAt)}</div>}
        </section>
      </CardContent>
    </Card>
  )
}

export function FeishuSettings({ feishu, logs, products, onSave, onTest }: Props) {
  const [webhookUrl, setWebhookUrl] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [cooldown, setCooldown] = useState(String(feishu.cooldownMinutes))
  const [busy, setBusy] = useState(false)
  const previewProduct = products.find((product) => product.lastSnapshot?.skuPrices?.length) || products[0]
  const previewSkus = previewProduct?.lastSnapshot?.skuPrices?.slice(0, 6) || []

  useEffect(() => setCooldown(String(feishu.cooldownMinutes)), [feishu.cooldownMinutes])

  async function save() {
    setBusy(true)
    try {
      await onSave({
        enabled: feishu.enabled,
        webhookUrl: webhookUrl || undefined,
        signingSecret: signingSecret || undefined,
        cooldownEnabled: feishu.cooldownEnabled,
        cooldownMinutes: Number(cooldown) || 120,
      })
      setWebhookUrl('')
      setSigningSecret('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2"><BellRing className="h-4 w-4 text-emerald-600" />飞书价格提醒</CardTitle>
            <div className="mt-1 text-sm text-slate-500">低于商品监控价时自动推送；Webhook 与签名密钥仅保存在本机加密数据中。</div>
          </div>
          <button type="button" role="switch" aria-checked={feishu.enabled} onClick={() => onSave({ enabled: !feishu.enabled })} className="inline-flex shrink-0 items-center gap-2 text-sm text-slate-600">
            自动提醒
            <span className={`relative h-6 w-11 rounded-full transition ${feishu.enabled ? 'bg-emerald-600' : 'bg-slate-200'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${feishu.enabled ? 'left-5' : 'left-0.5'}`} /></span>
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px] gap-3">
          <label className="grid gap-1 text-sm font-medium text-slate-700">机器人 Webhook
            <Input type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder={feishu.webhookConfigured ? feishu.webhookUrlMasked : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'} />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">签名密钥（可选）
            <Input type="password" value={signingSecret} onChange={(event) => setSigningSecret(event.target.value)} placeholder={feishu.signingSecretConfigured ? '已保存，输入新值可替换' : '机器人安全设置中的签名密钥'} />
          </label>
          <div className="grid gap-1">
            <div className="flex items-center justify-between gap-2 text-sm font-medium text-slate-700"><span>提醒冷却（分钟）</span><button type="button" role="switch" aria-label="飞书提醒冷却" aria-checked={feishu.cooldownEnabled} onClick={() => onSave({ cooldownEnabled: !feishu.cooldownEnabled })} className="inline-flex items-center gap-1.5 text-xs font-normal text-slate-500"><span>{feishu.cooldownEnabled ? '开启' : '关闭'}</span><span className={`relative h-5 w-9 rounded-full transition ${feishu.cooldownEnabled ? 'bg-amber-500' : 'bg-slate-200'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${feishu.cooldownEnabled ? 'left-[18px]' : 'left-0.5'}`} /></span></button></div>
            <Input aria-label="飞书提醒冷却分钟" min={1} max={1440} type="number" value={cooldown} onChange={(event) => setCooldown(event.target.value)} disabled={!feishu.cooldownEnabled} />
            <div className="text-[11px] text-slate-400">{feishu.cooldownEnabled ? `同一 SKU ${feishu.cooldownMinutes} 分钟内只提醒一次` : '关闭后每次命中监控价都会提醒'}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 rounded-md border border-slate-100 bg-slate-50 p-3 text-xs">
          <div><div className="font-medium text-violet-800">CLI 文档同步</div><div className="mt-1 leading-5 text-slate-500">每次价格抓取成功都会写入文档。提醒冷却期间也照常写入，不漏数据。</div></div>
          <div><div className="font-medium text-amber-800">机器人提醒冷却</div><div className="mt-1 leading-5 text-slate-500">{feishu.cooldownEnabled ? '已开启，只抑制同一商品、同一 SKU 的重复低价消息。' : '已关闭，每次低价命中都会发送机器人消息。'}不影响抓取、本地记录或文档同步。</div></div>
        </div>
        <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
          <Button type="button" onClick={save} disabled={busy}><Save className="h-4 w-4" />{busy ? '保存中' : '保存连接'}</Button>
          <Button type="button" variant="secondary" onClick={onTest} disabled={!feishu.webhookConfigured}><Send className="h-4 w-4" />发送测试</Button>
          {feishu.webhookConfigured && <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><ShieldCheck className="h-3.5 w-3.5" />Webhook 已连接</span>}
          {feishu.lastTestedAt && <span className="text-xs text-slate-400">最近测试 {timeAgo(feishu.lastTestedAt)}</span>}
          <a className="ml-auto inline-flex items-center gap-1 text-xs text-sky-700 hover:text-sky-800" href="https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot" target="_blank" rel="noreferrer">飞书群内创建机器人 <ExternalLink className="h-3 w-3" /></a>
        </div>
        {previewProduct && (
          <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-50">
            <div className="border-b border-orange-100 bg-orange-50 px-4 py-3">
              <div className="text-sm font-semibold text-orange-800">价格监控卡片预览</div>
              <div className="mt-0.5 truncate text-xs text-orange-600">{previewProduct.shopName || previewProduct.lastSnapshot?.shopName || '未知店铺'} · {previewProduct.model || previewProduct.lastSnapshot?.model || previewProduct.name}</div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 p-4">
              {previewSkus.map((sku) => <div key={sku.skuId} className="min-w-0 border-b border-slate-200 pb-2"><div className="truncate text-xs font-medium text-slate-700">{sku.name}</div><div className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-500"><span>{previewProduct.lastSnapshot?.accessMode === 'anonymous' ? '匿名' : '普通'} ¥{(sku.normalPrice ?? sku.price).toFixed(2)}</span><span>惊喜立减 {previewProduct.lastSnapshot?.accessMode === 'anonymous' ? '需登录' : sku.surprisePrice == null ? '未获取' : `¥${sku.surprisePrice.toFixed(2)}`}</span><span>淘金币 {previewProduct.lastSnapshot?.accessMode === 'anonymous' ? '需登录' : sku.coinPrice == null ? '无淘金币' : `¥${sku.coinPrice.toFixed(2)}`}</span><span className="text-amber-700">监控 {previewProduct.skuMonitorPrices?.[sku.skuId] ? `¥${previewProduct.skuMonitorPrices[sku.skuId].toFixed(2)}` : '--'}</span></div></div>)}
            </div>
          </div>
        )}
        <div className="max-h-48 space-y-2 overflow-auto border-t border-slate-100 pt-3">
          {logs.map((log) => <div key={log.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-100 px-3 py-2 text-xs"><div className="min-w-0"><div className="flex items-center gap-1 font-medium text-slate-700">{log.status === 'sent' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}{log.message}</div><div className="mt-0.5 text-slate-400">{log.price != null ? `当前 ¥${log.price.toFixed(2)}` : ''}{log.threshold != null ? ` · 监控 ¥${log.threshold.toFixed(2)}` : ''}</div></div><span className={log.status === 'failed' ? 'shrink-0 text-red-600' : log.status === 'suppressed' ? 'shrink-0 text-amber-600' : 'shrink-0 text-emerald-600'}>{log.status === 'failed' ? '失败' : log.status === 'suppressed' ? '冷却' : '已发送'} · {timeAgo(log.createdAt)}</span></div>)}
          {logs.length === 0 && <div className="py-3 text-sm text-slate-400">暂无飞书发送记录。</div>}
        </div>
      </CardContent>
    </Card>
  )
}
