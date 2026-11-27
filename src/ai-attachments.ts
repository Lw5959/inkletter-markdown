import type { AiAttachment, AiModelOptions, AiProtocol } from './contracts'
import { modelImageInput } from './ai-models'
import { invoke } from './native'

export type ReadAttachment = Omit<Extract<AiAttachment, { kind: 'text' }>, 'id'> | Omit<Extract<AiAttachment, { kind: 'binary' }>, 'id'>
export const maxAttachments = 8
const maxImageBytes = 3 * 1024 * 1024
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export function imageError(options?: AiModelOptions, mediaType?: string) {
  const supported = modelImageInput(options, mediaType)
  if (supported === undefined) return '当前模型的图片能力尚未确认。请在模型配置中获取规格，或设置图片输入。'
  if (!supported) return modelImageInput(options)
    ? '当前模型不支持这类图片。请换成模型支持的格式，或切换模型。'
    : '当前模型不支持图片输入。请切换到支持图片的模型。'
  return ''
}

export function attachmentError(files: ReadAttachment[], protocol: AiProtocol, options?: AiModelOptions) {
  for (const file of files) {
    if (file.kind === 'text') continue
    if (file.mediaType.startsWith('image/')) {
      const error = imageError(options, file.mediaType)
      if (error) return error
    } else if (file.mediaType !== 'application/pdf' && protocol !== 'responses') {
      return `「${file.name}」需要支持 Office 文件的 Responses 接口。请切换模型或添加文本版。`
    }
  }
  return ''
}

export async function readAttachments(command: 'ai_read_attachment' | 'android_ai_attachment', sources: string[]) {
  if (sources.length > maxAttachments) throw new Error('一次最多选择 8 个附件')
  const key = command === 'ai_read_attachment' ? 'path' : 'uri'
  return Promise.all(sources.map(source => invoke<ReadAttachment>(command, { [key]: source })))
}

export async function clipboardImages(images: File[]): Promise<ReadAttachment[]> {
  if (images.length > maxAttachments) throw new Error('一次最多粘贴 8 张图片')
  return Promise.all(images.map(async (file): Promise<ReadAttachment> => {
    if (!imageTypes.includes(file.type)) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片')
    if (!file.size || file.size > maxImageBytes) throw new Error('单张图片须小于或等于 3 MiB')
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.onerror = () => reject(new Error('无法读取剪贴板图片'))
      reader.readAsDataURL(file)
    })
    return { kind: 'binary', name: file.name || '剪贴板图片', mediaType: file.type, data }
  }))
}
