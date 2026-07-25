import { useEffect, useState } from 'react'
import type { ModelConfig, OperationsWorkspace } from '../../types/domain'
import { QwenPawChatEmbed } from './QwenPawChatEmbed'
import { OperationsThoughtDrawer } from './OperationsThoughtDrawer'

type OperationsAgentChatProps = {
  active: boolean
  workspace: OperationsWorkspace
  modelConfig: ModelConfig
  onOpenModelSettings: () => void
  onUpdateProfile: (payload: { principles?: string, dailyReport?: { enabled?: boolean, time?: string } }) => Promise<void>
  onDeleteReport: (id: string) => Promise<void>
}

export function OperationsAgentChat({ active, workspace, modelConfig, onOpenModelSettings, onUpdateProfile, onDeleteReport }: OperationsAgentChatProps) {
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const activeModel = modelConfig.channelStates?.[modelConfig.channel]
  const modelConfigured = activeModel?.hasApiKey ?? modelConfig.hasApiKey
  const modelName = activeModel?.model || modelConfig.model
  const runtimeKey = `${modelConfig.channel}|${modelConfig.customBaseUrl}|${modelName}|${modelConfigured}|${workspace.qwenPaw.signature || ''}`

  useEffect(() => {
    if (active && !modelConfigured) onOpenModelSettings()
  }, [active, modelConfigured, onOpenModelSettings])

  return <div className="space-y-3">
    <QwenPawChatEmbed active={active} modelConfigured={modelConfigured} modelRuntimeKey={runtimeKey} onOpenThinking={() => setThinkingOpen(true)} />
    <OperationsThoughtDrawer open={thinkingOpen} workspace={workspace} onClose={() => setThinkingOpen(false)} onUpdateProfile={onUpdateProfile} onDeleteReport={onDeleteReport} />
  </div>
}
