import { parser, GFM } from '@lezer/markdown'
import { invoke } from './native'

const markdown = parser.configure(GFM)
export type ImageLink = { from: number; to: number; url: string }
export type Relocated = { path: string; original: string | null }

export function localImage(url: string) {
  if (/^(?:[a-z]+:|\/\/)/i.test(url) && !/^[a-z]:[/\\]/i.test(url) && !url.startsWith('file://')) return null
  try {
    if (url.startsWith('file://')) {
      const parsed = new URL(url)
      const path = decodeURIComponent(parsed.pathname)
      if (parsed.host && parsed.host !== 'localhost') return '//' + parsed.host + path
      return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path
    }
    return decodeURIComponent(url.replace(/^<|>$/g, ''))
  } catch {
    return null
  }
}

export function assetPath(path: string) {
  return path.split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16))).join('/')
}

export function imageLinks(text: string): ImageLink[] {
  const links: ImageLink[] = []
  markdown.parse(text).iterate({ enter(ref) {
    if (ref.name !== 'Image') return
    const url = ref.node.getChild('URL')
    if (url) links.push({ from: url.from, to: url.to, url: text.slice(url.from, url.to) })
  } })
  return links
}

function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export async function insertImages(document: string, files: File[]) {
  const links: string[] = []
  for (const file of files) {
    if (file.type && !file.type.startsWith('image/')) continue
    const name = file.name.includes('.') ? file.name : '图片.' + (file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png')
    const path = await invoke<string>('image_insert', { document, name, data: await readFile(file) })
    links.push('![' + name.replace(/\.[^.]+$/, '').replace(/[\[\]\\]/g, '\\$&') + '](' + assetPath(path) + ')')
  }
  return links
}

export function resolveImage(document: string | null, url: string, remote: boolean) {
  if (/^data:image\//i.test(url) || (remote && /^https?:\/\//i.test(url))) return Promise.resolve(url)
  const image = localImage(url)
  if (!document || !image) return Promise.resolve('')
  return invoke<string>('image_data', { document, image }).catch(() => '')
}
