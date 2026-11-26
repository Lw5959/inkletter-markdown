import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Handlebars from 'handlebars'

const project = fileURLToPath(new URL('../', import.meta.url))
const source = join(project, 'src-tauri')
const readConfig = async name => JSON.parse(await readFile(join(source, name), 'utf8'))
const config = await readConfig('tauri.conf.json')
const windows = (await readConfig('tauri.windows.conf.json')).bundle.windows
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: source }))
const target = join(metadata.target_directory, 'x86_64-pc-windows-msvc', 'release')
const cache = resolve(process.env.YEYU_NSIS_CACHE ?? join(metadata.target_directory, 'release-tools', 'nsis-2.12.6'))
const output = join(target, 'bundle', 'nsis')
const temp = await mkdtemp(join(tmpdir(), 'yeyu-nsis-'))
const version = config.version
const name = config.productName
const installer = `${name}_${version}_x64-setup.exe`
const binary = 'yeyu.exe'
const templateBase = 'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.6/crates/tauri-bundler/src/bundle/windows/nsis/'
const inputs = {
  'installer.nsi': [templateBase + 'installer.nsi', 'd00089d3b1a2c4a30d7b6e098079100cb8f25e980f84d4515aca4597b95e967d'],
  'utils.nsh': [templateBase + 'utils.nsh', '56a8c227514158fc680b5ac71442d5f1087f94db50fda70592e13509fd869899'],
  'FileAssociation.nsh': [templateBase + 'FileAssociation.nsh', '85ce72519d5461b5777f95123176b5536de163abd9a4742f9235453c4ddf56d8'],
  'English.nsh': [templateBase + 'languages/English.nsh', '033e981b5c7d734c56e943d496aa0ca45df22da50617f91e80561e63b13bc2ef'],
  'nsis_tauri_utils.dll': ['https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll', '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709'],
}

async function input(file) {
  const [url, expected] = inputs[file]
  const cached = join(cache, file)
  const data = await readFile(cached).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return execFileSync('curl', ['-fLsS', '--retry', '2', '--connect-timeout', '10', '--max-time', '75', url])
  })
  if (createHash('sha256').update(data).digest('hex') !== expected) throw new Error(`NSIS 上游文件摘要不匹配 ${file}`)
  await writeFile(join(temp, file), data)
  await copyFile(join(temp, file), cached)
  return data.toString('utf8')
}

const nsisString = value => value.replace(/[$"`\r\n\t]/g, char => ({
  '$': '$$', '"': '$\\"', '`': '$\\`', '\r': '$\\r', '\n': '$\\n', '\t': '$\\t',
})[char])

try {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('NSIS 发行版本必须是三段稳定版本号')
  await mkdir(cache, { recursive: true })
  const [template, , , english] = await Promise.all(Object.keys(inputs).map(input))
  const exe = await readFile(join(target, binary))
  const prefix = '__TAURI_BUNDLE_TYPE_VAR_'
  const index = exe.indexOf(prefix)
  const end = index + prefix.length
  if (index < 0 || exe.lastIndexOf(prefix) !== index || !['UNK', 'NSS'].includes(exe.toString('utf8', end, end + 3))) {
    throw new Error('Windows 应用中缺少唯一的 Tauri 安装包类型标记')
  }
  // 只修改用于打包的副本，保留 Cargo 缓存中的原始可执行文件。
  exe.write('NSS', end, 'ascii')
  await writeFile(join(temp, binary), exe)

  const resources = {}
  const ancestors = new Set()
  let size = exe.length
  for (const [from, to] of Object.entries(config.bundle.resources ?? {})) {
    const resource = await readFile(resolve(source, from))
    const file = `resource-${Object.keys(resources).length}`
    await writeFile(join(temp, file), resource)
    const destinationDir = posix.dirname(to)
    for (let dir = destinationDir; dir !== '.'; dir = posix.dirname(dir)) ancestors.add(dir.replaceAll('/', '\\'))
    resources[file] = [destinationDir === '.' ? '' : nsisString(destinationDir.replaceAll('/', '\\')), nsisString(to.replaceAll('/', '\\'))]
    size += resource.length
  }
  const folders = [...ancestors].sort((a, b) => b.length - a.length).map(nsisString)
  await copyFile(resolve(source, windows.nsis.installerHooks), join(temp, 'markdown.nsh'))
  const data = {
    product_name: name, version, version_with_build: version + '.0', manufacturer: 'yeyu',
    bundle_id: config.identifier, arch: 'x64', main_binary_name: 'yeyu', main_binary_path: binary,
    homepage: 'https://github.com/Lw5959/yeyu', out_file: installer, estimated_size: Math.ceil(size / 1024),
    installer_hooks: 'markdown.nsh', install_mode: windows.nsis.installMode,
    additional_plugins_path: '.', compression: 'lzma', display_language_selector: 'false',
    allow_downgrades: String(windows.allowDowngrades ?? true), languages: ['English'], language_files: ['English.nsh'],
    resources, resources_dirs: folders, resources_ancestors: folders, binaries: {}, deep_link_protocols: [], file_associations: [],
    install_webview2_mode: 'downloadBootstrapper', webview2_installer_args: '/silent',
    webview2_bootstrapper_path: '', webview2_installer_path: '', minimum_webview2_version: '',
    installer_icon: '', uninstaller_icon: '', header_image: '', sidebar_image: '', uninstaller_header_image: '',
    license: '', copyright: '', start_menu_folder: '', uninstaller_sign_cmd: '', signed_plugins_path: '',
  }
  // 上游模板使用 NSIS 字符串转义，源文件名则由构建目录生成。
  const handlebars = Handlebars.create()
  handlebars.registerHelper('no-escape', value => value)
  handlebars.registerHelper('or', (left, right) => left || right)
  handlebars.registerHelper('association-description', (description, ext) => description || `${ext} File`)
  const safe = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value === 'string' ? nsisString(value) : value]))
  const render = template => handlebars.compile(template, { noEscape: true, strict: true })(safe)
  // Unix 宿主文件没有 Win32 文件属性。内置英文已定义正确拼写的安装提示。
  const portable = template.replace(/^([ \t]*File)[ \t]+\/a\b/gm, '$1')
    .replace(/^.*\$\(choowHowToInstall\).*\n/gm, '')
    .replace(/^LangString choowHowToInstall .*\n/gm, '')
  await writeFile(join(temp, 'English.nsh'), '\uFEFF' + render(english))
  await writeFile(join(temp, 'installer.nsi'), '\uFEFF' + render(portable))
  execFileSync('makensis', ['-WX', '-INPUTCHARSET', 'UTF8', '-V3', 'installer.nsi'], { cwd: temp, stdio: 'inherit' })
  await mkdir(output, { recursive: true })
  const staged = join(output, installer)
  const built = join(temp, basename(staged))
  const signing = process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH
  if (signing) {
    execFileSync('pnpm', ['tauri', 'signer', 'sign', '--app-version', version, built], { cwd: project, stdio: 'inherit' })
    await copyFile(built + '.sig', staged + '.sig.partial')
  }
  await copyFile(built, staged + '.partial')
  await rename(staged + '.partial', staged)
  if (signing) await rename(staged + '.sig.partial', staged + '.sig')
  else await rm(staged + '.sig', { force: true })
  console.log(staged)
} finally {
  await rm(temp, { recursive: true, force: true })
}
