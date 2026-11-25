import { getVersion } from '@tauri-apps/api/app'
import { choose } from './dialogs'

const repository = 'https://github.com/Lw5959/yeyu'
const api = 'https://api.github.com/repos/Lw5959/yeyu/releases/latest'

export type ReleaseInfo = { version: string; notes: string; url: string }

function versionParts(value: string) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!parts) throw new Error('发布版本号无效')
  return parts.slice(1).map(Number)
}

export async function checkPublishedPackage(suffix: string): Promise<ReleaseInfo | null> {
  const installed = await getVersion()
  const response = await fetch(api, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('GitHub Releases 暂不可用，请稍后重试')
  const release = await response.json() as { tag_name: string; body?: string; assets: { name: string; browser_download_url: string }[] }
  const next = versionParts(release.tag_name)
  const current = versionParts(installed)
  const firstChange = next.findIndex((part, index) => part !== current[index])
  if (firstChange < 0 || next[firstChange] < current[firstChange]) return null
  const version = next.join('.')
  const asset = `Yeyu_${version}_${suffix}`
  const url = `${repository}/releases/download/${release.tag_name}/${asset}`
  // 只接受本仓库、当前版本和当前架构匹配的安装包。
  if (!release.assets.some(item => item.name === asset && item.browser_download_url === url)) {
    throw new Error('GitHub Release 暂未提供此设备的安装包')
  }
  return { version, notes: release.body ?? '', url }
}

export function offerUpdate(update: Pick<ReleaseInfo, 'version' | 'notes'>, action: '下载更新' | '安装更新') {
  return choose(`页屿 ${update.version} 可用`, update.notes.trim().slice(0, 900) || 'GitHub Releases 已发布新版本。', [
    { label: '稍后', value: 'cancel' }, { label: action, value: 'apply', primary: true },
  ])
}
