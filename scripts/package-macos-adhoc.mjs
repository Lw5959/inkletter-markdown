import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const [input, directory] = process.argv.slice(2)
if (process.platform !== 'darwin' || !input?.endsWith('.app') || !directory) {
  throw new Error('用法为 node scripts/package-macos-adhoc.mjs <应用包路径> <产物目录>')
}
const app = basename(input)
const plist = join(input, 'Contents/Info.plist')
const attribute = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist], { encoding: 'utf8' }).trim()
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
if (attribute('CFBundleShortVersionString') !== version) throw new Error('macOS 应用包与发布版本不一致')
const binary = join(input, 'Contents/MacOS', attribute('CFBundleExecutable'))
const architecture = execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' }).trim()
const target = { arm64: 'arm64', x86_64: 'x64' }[architecture]
if (!target) throw new Error('macOS 发布包必须采用独立的 ARM64 或 Intel 架构')

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
const output = resolve(directory)
const name = 'Yeyu_' + version + '_macos-' + target
mkdirSync(output, { recursive: true })
const stage = mkdtempSync(join(output, '.macos-'))
try {
  const image = join(stage, 'image')
  mkdirSync(image)
  const copy = join(image, app)
  run('ditto', [input, copy])
  // 本地临时签名先写入应用，再打包和签署更新归档。
  run('codesign', ['--force', '--sign', '-', copy])
  run('codesign', ['--verify', '--deep', '--strict', copy])
  const archive = join(stage, name + '.app.tar.gz')
  run('tar', ['--no-mac-metadata', '-czf', archive, '-C', image, app])
  run('pnpm', ['tauri', 'signer', 'sign', '--app-version', version, archive])

  symlinkSync('/Applications', join(image, 'Applications'))
  const disk = join(stage, name + '.dmg')
  const volume = app.slice(0, -4)
  const help = spawnSync('diskutil', ['image', 'create', 'from', '--help'], { encoding: 'utf8' })
  if ((help.stdout + help.stderr).includes('diskutil image create from')) {
    run('diskutil', ['image', 'create', 'from', '--format', 'UDZO', '--volumeName', volume, image, disk])
  } else {
    run('hdiutil', ['create', '-srcfolder', image, '-volname', volume, '-format', 'UDZO', disk])
  }
  run('hdiutil', ['verify', disk])
  for (const suffix of ['.app.tar.gz', '.app.tar.gz.sig', '.dmg']) {
    renameSync(join(stage, name + suffix), join(output, name + suffix))
  }
} finally {
  rmSync(stage, { recursive: true, force: true })
}
