import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [bundles, platform, output] = process.argv.slice(2)
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const prefix = `Yeyu_${version}_`
const files = (await readdir(bundles, { recursive: true })).sort()

async function stage(extension, name, signed = false) {
  const matches = files.filter(path => path.endsWith(extension))
  if (matches.length !== 1) throw new Error(`需要一个 ${extension} 产物，找到 ${matches.length} 个`)
  const source = join(bundles, matches[0])
  const target = join(output, prefix + name)
  await copyFile(source, target)
  if (signed) await copyFile(source + '.sig', target + '.sig')
}

await mkdir(output, { recursive: true })
switch (platform) {
  case 'macos-arm64':
  case 'macos-x64':
    await stage('.dmg', `${platform}.dmg`)
    await stage('.app.tar.gz', `${platform}.app.tar.gz`, true)
    break
  case 'windows-x64':
    await stage('-setup.exe', 'windows-x64-setup.exe', true)
    break
  case 'linux-x64':
  case 'linux-arm64':
    await stage('.deb', `${platform}.deb`)
    await stage('.AppImage', `${platform}.AppImage`, true)
    break
  default:
    throw new Error('未知发布平台 ' + platform)
}
