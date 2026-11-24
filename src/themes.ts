import postcss from 'postcss'
import type { AtRule, Root } from 'postcss'
import selectorParser from 'postcss-selector-parser'
import valueParser from 'postcss-value-parser'
import type { Node as ValueNode } from 'postcss-value-parser'
import type { Theme } from './contracts'
import { invoke } from './native'

type Import = { id: string; name: string; entry: string }

const compatible: Record<string, string> = {
  h1: ':is(h1,.live-h1,.md-h1)', h2: ':is(h2,.live-h2,.md-h2)', h3: ':is(h3,.live-h3,.md-h3)',
  h4: ':is(h4,.live-h4,.md-h4)', h5: ':is(h5,.live-h5,.md-h5)', h6: ':is(h6,.live-h6,.md-h6)',
  blockquote: ':is(blockquote,.md-blockquote)',
}

function resourcePath(value: string, owner: string) {
  if (!value || value.startsWith('#') || /^(?:[\w+.-]+:|\/|\\)/.test(value)) return null
  const base = 'https://theme.invalid/' + owner.split('/').map(encodeURIComponent).join('/')
  const path = new URL(value, base)
  return path.origin === 'https://theme.invalid' ? decodeURIComponent(path.pathname.slice(1)) : null
}

function argument(node: ValueNode | undefined): string | undefined {
  if (!node) return
  if (node.type === 'string') return node.value
  if (node.type === 'function' && node.value.toLowerCase() === 'url') {
    return node.nodes.find(item => item.type === 'string' || item.type === 'word')?.value
  }
}

function wrapImport(imported: Root, condition: ValueNode[]) {
  // 保留 @import 的层、supports 与媒体条件，并把导入内容嵌入原来的级联位置。
  const clauses: ValueNode[] = condition.filter(node => node.type !== 'space')
  const wrappers: AtRule[] = []
  if (clauses[0]?.value === 'layer') {
    const layer = clauses.shift()!
    wrappers.push(postcss.atRule({ name: 'layer', params: layer.type === 'function' ? valueParser.stringify(layer.nodes) : '' }))
  }
  if (clauses[0]?.type === 'function' && clauses[0].value === 'supports') {
    const supports = clauses.shift()!
    if (supports.type === 'function') wrappers.push(postcss.atRule({ name: 'supports', params: '(' + valueParser.stringify(supports.nodes) + ')' }))
  }
  const firstMedia = clauses[0]
  const media = firstMedia ? condition.slice(condition.indexOf(firstMedia)) : []
  if (media.length) wrappers.push(postcss.atRule({ name: 'media', params: valueParser.stringify(media).trim() }))
  let nodes: (AtRule | Root['nodes'][number])[] = [...imported.nodes]
  for (const wrapper of wrappers.reverse()) {
    wrapper.append(nodes)
    nodes = [wrapper]
  }
  return nodes
}

export function scopeTheme(css: Root) {
  css.walkRules(rule => {
    let parent: typeof rule.parent | Root['parent'] = rule.parent
    while (parent) {
      if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return
      parent = parent.parent
    }
    rule.selector = selectorParser(selectors => {
      selectors.each(selector => {
        const roots = selector.nodes.filter(node => (node.type === 'tag' && /^(html|body)$/i.test(node.value)) ||
          (node.type === 'pseudo' && node.value === ':root'))
        for (const node of roots) node.replaceWith(selectorParser.className({ value: 'document-theme' }))
        if (!roots.length || selector.first?.type !== 'class' || selector.first.value !== 'document-theme') {
          const descendant = selectorParser.combinator({ value: ' ' })
          selector.prepend(descendant)
          selector.prepend(selectorParser.className({ value: 'document-theme' }))
        }
        selector.walkTags(node => {
          const replacement = compatible[node.value.toLowerCase()]
          if (!replacement) return
          const alias = selectorParser().astSync(replacement).first.first.clone()
          node.replaceWith(alias)
        })
      })
    }).processSync(rule.selector).replace(/\.document-theme\s+(?:>\s*)?\.document-theme/g, '.document-theme')
  })
  return css.toString()
}

export async function importTheme(path: string): Promise<{ theme: Theme; missing: string[] }> {
  const info = await invoke<Import>('theme_begin', { path })
  const missing = new Set<string>()
  const resources = new Map<string, Promise<string | null>>()
  const read = (assetPath: string) => {
    let request = resources.get(assetPath)
    if (!request) {
      request = invoke<string | null>('theme_read', { id: info.id, path: assetPath })
      resources.set(assetPath, request)
    }
    return request
  }

  async function compile(assetPath: string, ancestors: string[] = []): Promise<Root | null> {
    if (ancestors.includes(assetPath)) throw new Error('主题 CSS 存在循环导入：' + assetPath)
    const content = await read(assetPath)
    if (content === null) return null
    const root = postcss.parse(content, { from: assetPath })
    const declarations: { parsed: ReturnType<typeof valueParser>; node: import('postcss').Declaration }[] = []
    root.walkDecls(node => { if (/url\(/i.test(node.value)) declarations.push({ parsed: valueParser(node.value), node }) })
    for (const { parsed, node } of declarations) {
      const urls: ValueNode[] = []
      parsed.walk(value => { if (value.type === 'function' && value.value.toLowerCase() === 'url') urls.push(value) })
      for (const url of urls) {
        if (url.type !== 'function') continue
        const target = argument(url)
        if (!target || target.startsWith('#') || /^data:(?:image\/|font\/|application\/(?:font|x-font))/.test(target)) continue
        const relative = resourcePath(target, assetPath)
        const data = relative ? await read(relative) : null
        if (!data || !data.startsWith('data:')) missing.add(target)
        url.nodes = [{ type: 'string', quote: '"', value: data?.startsWith('data:') ? data : 'data:,', sourceIndex: 0, sourceEndIndex: 0 }]
      }
      node.value = parsed.toString()
    }
    const imports: AtRule[] = []
    root.walkAtRules(/^import$/i, rule => { imports.push(rule) })
    for (const rule of imports) {
      const values = valueParser(rule.params).nodes.filter(value => value.type !== 'comment')
      const index = values.findIndex(value => value.type !== 'space')
      const target = argument(values[index])
      const relative = target ? resourcePath(target, assetPath) : null
      const imported = relative ? await compile(relative, [...ancestors, assetPath]) : null
      if (imported) rule.replaceWith(...wrapImport(imported, values.slice(index + 1)))
      else {
        if (target) missing.add(target)
        rule.remove()
      }
    }
    root.walkAtRules(/^charset$/i, node => { node.remove() })
    return root
  }

  try {
    const styles: string[] = []
    for (const file of [info.entry, 'base.user.css', info.entry.replace(/\.css$/i, '.user.css')]) {
      const root = await compile(file)
      if (root) styles.push(scopeTheme(root))
    }
    if (!styles.length) throw new Error('所选目录缺少主题 CSS')
    const theme = { id: info.id, name: info.name, styles }
    await invoke('theme_finish', { theme })
    return { theme, missing: [...missing] }
  } catch (error) {
    await invoke('theme_abort', { id: info.id })
    throw error
  }
}
