import { useState } from 'react'
import { KeyRound, Save } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import type { Overview } from '../../types/domain'

type Props = {
  config: Overview['modelConfig']
  onSave: (payload: { baseUrl?: string; apiKey?: string; model?: string }) => Promise<void>
}

export function ModelConfigPanel({ config, onSave }: Props) {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl || 'https://api.openai.com/v1')
  const [model, setModel] = useState(config.model || 'gpt-4.1-mini')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    try {
      await onSave({ baseUrl, model, apiKey })
      setApiKey('')
      setMessage('模型配置已保存。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '模型配置保存失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-emerald-600" />
          模型配置
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            API 地址
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            模型
            <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4.1-mini" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            API Key
            <Input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={config.hasApiKey ? `已配置：${config.apiKey || '环境变量'}` : '粘贴模型 API Key'}
              type="password"
            />
          </label>
          <Button type="submit" disabled={saving}>
            <Save className="h-4 w-4" />
            {saving ? '保存中' : '保存模型配置'}
          </Button>
          <p className="text-xs leading-5 text-slate-500">
            当前：{config.model || model} · {config.hasApiKey ? '已配置 Key' : '未配置 Key，将使用本地规则分析'}
          </p>
          {message && <p className="text-xs leading-5 text-slate-500">{message}</p>}
        </form>
      </CardContent>
    </Card>
  )
}
