import type { AiModelOptions, AiProviderDraft, AiReasoningEffort } from './contracts'

export const effortLabels = {
  default: '默认', none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高',
} as const
type EffortChoice = keyof typeof effortLabels

export function optionsForModel(provider: AiProviderDraft, id: string) {
  const options = provider.modelOptions
  return options && Object.hasOwn(options, id) ? options[id] : undefined
}

export function modelEfforts(id: string, options?: AiModelOptions): EffortChoice[] {
  const name = id.toLowerCase().split('/').at(-1) ?? ''
  let levels = options?.detected?.reasoningEfforts
  if (!levels) {
    // 未获取规格时，沿用已知模型的档位和通用协议档位。
    if (name.startsWith('deepseek-v4-pro')) levels = ['high', 'max']
    else if (name.startsWith('deepseek-v4') || name === 'deepseek-flash' || name.startsWith('glm-5')) levels = ['low', 'high', 'max']
    else levels = ['low', 'medium', 'high']
  }
  const values = new Set<AiReasoningEffort>(levels)
  if (options?.reasoningEffort) values.add(options.reasoningEffort)
  return ['default', ...values]
}

export function modelDisplayName(id: string, options?: AiModelOptions) {
  return options?.displayName || options?.detected?.displayName || id
}

export function detectedInputTokens(options: AiModelOptions) {
  const { detected } = options
  if (detected?.inputTokens) return detected.inputTokens
  if (detected?.contextTokens) {
    // API 只提供总窗口时，从总窗口扣除配置的输出预算。
    const remaining = detected.contextTokens - (options.outputTokens ?? detected.outputTokens ?? 0)
    if (remaining > 0) return remaining
  }
}

export function modelImageInput(options?: AiModelOptions, mediaType?: string) {
  if (options?.imageInput !== undefined) return options.imageInput
  return options?.detected?.inputModalities?.some(mode =>
    mode === 'image' || mode === 'image/*' || (mediaType ? mode === mediaType : mode.startsWith('image/')))
}

export function activeModel(settings: import('./contracts').AiSettings) {
  const provider = settings.providers.find(item => item.id === settings.active?.providerId)
  return provider && settings.active
    ? { provider, selection: settings.active, options: optionsForModel(provider, settings.active.model) }
    : undefined
}
