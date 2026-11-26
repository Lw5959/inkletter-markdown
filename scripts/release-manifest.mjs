import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const [output, tag, repository, giteeOutput] = process.argv.slice(2)
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url)))
if (!output || tag !== `v${version}` || config.version !== version || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
  throw new Error('发布标签、应用版本和仓库必须一致')
}
if (giteeOutput && resolve(giteeOutput) === resolve(output)) throw new Error('GitHub 和 Gitee 清单需要不同的目录')

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

const installable = ['linux-x64.deb', 'linux-arm64.deb', 'android-arm64.apk']
const minimum = ['macos-arm64.dmg', 'macos-x64.dmg', ...installable, ...Object.values(targets)]
const files = (await readdir(output)).sort().filter(file => file.startsWith(prefix))
for (const suffix of minimum) {
  if (!files.includes(prefix + suffix)) throw new Error('缺少安装包 ' + suffix)
}
await writeFile(join(output, 'latest.json'), JSON.stringify({ version, platforms }, null, 2) + '\n')
async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const hashes = new Map()
for (const file of files) hashes.set(file, await sha256(join(output, file)))
function checksumText(entries) {
  return [...entries].map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n'
}
await writeFile(join(output, 'SHA256SUMS'), checksumText([...hashes, ['latest.json', await sha256(join(output, 'latest.json'))]]))

if (giteeOutput) {
  const endpoint = new URL(config.plugins.updater.endpoints[1])
  const [, owner, name, ...path] = endpoint.pathname.split('/')
  if (endpoint.origin !== 'https://gitee.com' || path.join('/') !== 'raw/updates/latest.json' || !/^[\w.-]+\/[\w.-]+$/.test(`${owner}/${name}`)) {
    throw new Error('Gitee 更新源配置不完整')
  }
  const release = `${endpoint.origin}/${owner}/${name}/releases/download/${tag}`
  const mirrored = Object.fromEntries(Object.entries(targets).map(([key, suffix]) => [key, {
    signature: platforms[key].signature, url: `${release}/${prefix + suffix}`,
  }]))
  const sizes = new Map()
  for (const file of files) {
    const { size } = await stat(join(output, file))
    if (size > 100_000_000) throw new Error(`Gitee 普通仓库的单附件须小于或等于 100 MB ${file}`)
    sizes.set(file, size)
  }
  const packages = Object.fromEntries(installable.map(suffix => {
    const file = prefix + suffix
    return [suffix, { url: `${release}/${file}`, size: sizes.get(file), sha256: hashes.get(file) }]
  }))
  await mkdir(giteeOutput, { recursive: true })
  const feed = join(giteeOutput, 'latest.json')
  await writeFile(feed, JSON.stringify({ version, platforms: mirrored, packages }, null, 2) + '\n')
  await writeFile(join(giteeOutput, 'SHA256SUMS'), checksumText([...hashes, ['latest.json', await sha256(feed)]]))
}
