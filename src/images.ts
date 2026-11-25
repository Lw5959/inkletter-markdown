import { parser, GFM } from '@lezer/markdown'
import { frontMatter } from './editor/front-matter'
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
  // 解析器使用 LF，记录被折叠的 CRLF 以便把替换范围映射回原文。
  const collapsed: number[] = []
  const normalized = text.replace(/\r\n?/g, (ending, offset: number) => {
    if (ending.length === 2) collapsed.push(offset - collapsed.length)
    return '\n'
  })
  const yamlEnd = frontMatter(normalized)?.[0].length ?? 0
  let extra = 0
  const original = (offset: number) => {
    while (extra < collapsed.length && collapsed[extra] < offset) extra++
    return offset + extra
  }
  markdown.parse(normalized).iterate({ enter(ref) {
    if (ref.name !== 'Image' || ref.from < yamlEnd) return
    const url = ref.node.getChild('URL')
    if (url) {
      const from = original(url.from)
      const to = original(url.to)
      links.push({ from, to, url: text.slice(from, to) })
    }
    return false
  } })
  return links
}

type Fingerprint = { digest: string; extension: string }
type ImageProbe = { Ok: Fingerprint } | { Err: string }
type PlannedImage = { image: string; name: string; digest: string }

export async function planImageCollection(
  document: { path: string; name: string }, text: string, nameImages: (input: string) => Promise<string>,
) {
  const local = imageLinks(text).flatMap(link => {
    const image = localImage(link.url.replace(/\\([()<> ])/g, '$1'))
    return image && !/^[/\\]{2}/.test(image) ? [{ ...link, image }] : []
  })
  const sources = [...new Set(local.map(link => link.image))]
  const issues: string[] = []
  if (!sources.length) return { replacement: text, copies: [], count: 0, updatedLinks: 0, folder: '', issues }
  const reports = await invoke<ImageProbe[]>('image_fingerprints', { document: document.path, images: sources })
  const valid = new Map<string, Fingerprint>()
  const groups = new Map<string, Fingerprint>()
  const key = ({ digest, extension }: Fingerprint) => `${digest}.${extension}`
  for (const [index, result] of reports.entries()) {
    const image = sources[index]
    if ('Err' in result) {
      issues.push(image + ' · ' + result.Err)
      continue
    }
    valid.set(image, result.Ok)
    groups.set(key(result.Ok), result.Ok)
  }
  if (!groups.size) return { replacement: text, copies: [], count: 0, updatedLinks: 0, folder: '', issues }
  // 插件只收到摘要和扩展名，文件访问及替换范围都由宿主掌握。
  const result: unknown = JSON.parse(await nameImages(JSON.stringify({ images: [...groups.values()] })))
  if (!Array.isArray(result) || result.length !== groups.size ||
      !result.every(name => typeof name === 'string' && /^[a-z0-9_-]{1,100}\.[a-z0-9]+$/.test(name)) ||
      new Set(result).size !== result.length) {
    throw new Error('插件返回了无效的图片命名方案')
  }
  const names = new Map([...groups.keys()].map((key, index) => [key, result[index] as string]))
  const dot = document.name.lastIndexOf('.')
  const folder = (dot > 0 ? document.name.slice(0, dot) : document.name) + '.assets'
  const copies = new Map<string, PlannedImage>()
  const parts: string[] = []
  let offset = 0
  let updatedLinks = 0
  for (const link of local) {
    const info = valid.get(link.image)
    if (!info) continue
    const name = names.get(key(info))!
    if (!name.endsWith('.' + info.extension)) throw new Error('整理后的图片扩展名须与原图一致')
    const replacement = assetPath(folder + '/' + name)
    if (replacement === link.url) continue
    parts.push(text.slice(offset, link.from), replacement)
    offset = link.to
    updatedLinks++
    copies.set(link.image, { image: link.image, name, digest: info.digest })
  }
  parts.push(text.slice(offset))
  return {
    replacement: parts.join(''), copies: [...copies.values()], updatedLinks,
    count: new Set([...copies.values()].map(item => item.name)).size, folder, issues,
  }
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
