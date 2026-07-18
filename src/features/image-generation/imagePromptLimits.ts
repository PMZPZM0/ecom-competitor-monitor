export const IMAGE_PROMPT_LIMITS = {
  prompt: 4_000,
  negativePrompt: 2_000,
} as const

export function overlongImagePrompt(prompt: string, negativePrompt = '') {
  if (prompt.length > IMAGE_PROMPT_LIMITS.prompt) {
    return { label: '正向提示词', length: prompt.length, limit: IMAGE_PROMPT_LIMITS.prompt }
  }
  if (negativePrompt.length > IMAGE_PROMPT_LIMITS.negativePrompt) {
    return { label: '排除要求', length: negativePrompt.length, limit: IMAGE_PROMPT_LIMITS.negativePrompt }
  }
  return null
}
