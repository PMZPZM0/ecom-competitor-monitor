const INTERNAL_PROMPT_MARKER = '以下为服务端硬约束，优先级高于前文的创意描述，不得省略、改写或冲突：'
const INTERNAL_NEGATIVE_MARKER = '以下为服务端基础排除规则（自动执行，无需编辑）：'

export type PromptLayers = {
  visible: string
  hidden: string
}

function splitAtMarker(value: string | undefined, marker: string): PromptLayers {
  const source = String(value || '')
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) return { visible: source.trim(), hidden: '' }
  return {
    visible: source.slice(0, markerIndex).trim(),
    hidden: source.slice(markerIndex).trim(),
  }
}

function compose(visible: string, hidden: string) {
  return [visible.trim(), hidden.trim()].filter(Boolean).join('\n\n')
}

export function splitPromptLayers(value: string | undefined) {
  return splitAtMarker(value, INTERNAL_PROMPT_MARKER)
}

export function splitNegativePromptLayers(value: string | undefined) {
  return splitAtMarker(value, INTERNAL_NEGATIVE_MARKER)
}

export function visiblePrompt(value: string | undefined) {
  return splitPromptLayers(value).visible
}

export function visibleNegativePrompt(value: string | undefined) {
  return splitNegativePromptLayers(value).visible
}

export function composePromptWithHidden(visible: string, original: string | undefined) {
  return compose(visible, splitPromptLayers(original).hidden)
}

export function composeNegativePromptWithHidden(visible: string, original: string | undefined) {
  return compose(visible, splitNegativePromptLayers(original).hidden)
}
