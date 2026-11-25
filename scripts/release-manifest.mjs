import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [output, tag, repository] = process.argv.slice(2)
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url)))
if (!output || tag !== `v${version}` || config.version !== version || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
  throw new Error('发布标签、应用版本和仓库必须一致')
}

const prefix = `Yeyu_${version}_`
const targets = {
  'darwin-aarch64': 'macos-arm64.app.tar.gz', 'darwin-x86_64': 'macos-x64.app.tar.gz',
  'windows-x86_64': 'windows-x64-setup.exe', 'linux-aarch64': 'linux-arm64.AppImage', 'linux-x86_64': 'linux-x64.AppImage',
}
const platforms = {}
for (const [key, suffix] of Object.entries(targets)) {
  const asset = prefix + suffix
  const signature = (await readFile(join(output, asset + '.sig'), 'utf8')).trim()
  if (!signature) throw new Error('缺少发布签名 ' + asset)
  platforms[key] = { signature, url: `https://github.com/${repository}/releases/download/${tag}/${asset}` }
}

const minimum = ['macos-arm64.dmg', 'macos-x64.dmg', 'linux-x64.deb', 'linux-arm64.deb', 'android-arm64.apk', ...Object.values(targets)]
const files = (await readdir(output)).sort().filter(file => file.startsWith(prefix))
for (const suffix of minimum) {
  if (!files.includes(prefix + suffix)) throw new Error('缺少安装包 ' + suffix)
}
await writeFile(join(output, 'latest.json'), JSON.stringify({ version, platforms }, null, 2) + '\n')
const checksums = []
for (const file of [...files, 'latest.json']) {
  const hash = createHash('sha256').update(await readFile(join(output, file))).digest('hex')
  checksums.push(`${hash}  ${file}`)
}
await writeFile(join(output, 'SHA256SUMS'), checksums.join('\n') + '\n')
