import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


SOURCE = 'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.6/crates/tauri-bundler/src/bundle/linux/appimage/'
APPRUN = 'https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/'
GTK_HASH = 'ef6b9a980417243bc62e0241b51dc49876032afd1bab9b4762389f961b406d9b'
ARCHITECTURES = {
    'arm64': ('aarch64', '072f17c0895a85c490282fe5395c5007e5fc75da727e553b3b8fb680feb11578'),
    'amd64': ('x86_64', 'f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f'),
}
# 由目标 Linux 提供动态加载器、glibc 和硬件驱动接口。
SYSTEM_LIBRARIES = {
    'libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1', 'libresolv.so.2',
    'libstdc++.so.6', 'libgcc_s.so.1', 'libGL.so.1', 'libGLX.so.0', 'libEGL.so.1',
    'libGLdispatch.so.0', 'libdrm.so.2', 'libgbm.so.1', 'libvulkan.so.1',
}


def verified_tool(cache, name, url, digest):
    path = cache / name
    if path.exists():
        content = path.read_bytes()
    else:
        content = subprocess.check_output(['curl', '-fLsS', '--connect-timeout', '10', '--max-time', '75', url])
    if hashlib.sha256(content).hexdigest() != digest:
        raise SystemExit('AppImage 构建工具摘要不匹配 ' + name)
    path.write_bytes(content)
    path.chmod(0o755)
    return path


def elf_files(directory):
    for entry in directory.rglob('*'):
        if entry.is_file() and not entry.is_symlink():
            with entry.open('rb') as file:
                if file.read(4) == b'\x7fELF':
                    yield entry


def deploy_libraries(seeds, requested, library_dir):
    # ldd 为每个入口解析完整的 DT_NEEDED 依赖树。所有入口均来自当前发行构建或系统包。
    files = {library.name: library for library in requested}
    for seed in sorted(set(seeds) | set(requested)):
        linked = subprocess.check_output(['ldd', str(seed)], text=True)
        if '=> not found' in linked:
            raise SystemExit(f'无法解析 {seed} 的共享库\n{linked}')
        for name, path in re.findall(r'^\s*(\S+) => (/[^\n]+?) \(', linked, re.MULTILINE):
            if name in SYSTEM_LIBRARIES or name.startswith(('ld-linux', 'libnss_')):
                continue
            source = Path(path)
            if name in files and files[name].resolve() != source.resolve():
                raise SystemExit('同名共享库解析到不同位置 ' + name)
            files[name] = source
    for name, source in sorted(files.items()):
        shutil.copy2(source, library_dir / name)


def stage_gtk(stage, appdir, gtk, triplet):
    library_dir = appdir / 'usr/lib'
    # GTK 插件准备模块和缓存。它要求的库与应用依赖在同一轮部署，避免二次剥离与覆盖入口。
    collector = stage / 'collect-gtk'
    requested = stage / 'gtk-libraries'
    collector.write_text('''#!/bin/sh
set -eu
for item do
    case "$item" in
        --appdir=*) test "${item#*=}" = "$YEYU_APPDIR" ;;
        --library=*) printf '%s\\n' "${item#*=}" >> "$YEYU_GTK_LIBRARIES" ;;
        *) exit 1 ;;
    esac
done
''')
    collector.chmod(0o755)
    requested.touch()
    (appdir / 'usr/lib64').mkdir(exist_ok=True)
    env = os.environ | {'DEPLOY_GTK_VERSION': '3', 'LINUXDEPLOY': str(collector),
                        'YEYU_APPDIR': str(appdir), 'YEYU_GTK_LIBRARIES': str(requested)}
    subprocess.run(['bash', str(gtk), '--appdir', str(appdir)], check=True, env=env)

    webkit = Path('/usr/lib') / triplet / 'webkit2gtk-4.1'
    for file in ('WebKitNetworkProcess', 'WebKitWebProcess', 'injected-bundle/libwebkit2gtkinjectedbundle.so'):
        target = appdir / webkit.relative_to('/') / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(webkit / file, target)

    extra = [Path(line) for line in requested.read_text().splitlines()]
    deploy_libraries([appdir / 'usr/bin/yeyu', *elf_files(library_dir)], extra, library_dir)
    # 沿用 Tauri 的 WebKit 资源定位方式，从挂载后的 AppDir 加载子进程及注入文件。
    for webkit_lib in library_dir.glob('libwebkit*'):
        webkit_lib.write_bytes(webkit_lib.read_bytes().replace(b'/usr', b'././'))


def package(deb, output):
    arch = subprocess.check_output(['dpkg-deb', '-f', str(deb), 'Architecture'], text=True).strip()
    if arch != subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip() or arch not in ARCHITECTURES:
        raise SystemExit('须在与 DEB 相同架构的 Debian 构建环境中生成 AppImage')
    machine, apprun_hash = ARCHITECTURES[arch]
    triplet = subprocess.check_output(['dpkg-architecture', '-qDEB_HOST_MULTIARCH'], text=True).strip()
    cache = Path(os.environ.get('YEYU_APPIMAGE_TOOLS', Path.home() / '.cache/yeyu-appimage')).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    gtk = verified_tool(cache, 'linuxdeploy-plugin-gtk.sh', SOURCE + 'linuxdeploy-plugin-gtk.sh', GTK_HASH)
    apprun = verified_tool(cache, 'AppRun-' + machine, APPRUN + 'AppRun-' + machine, apprun_hash)

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='yeyu-appimage-', dir=output.parent) as temp:
        stage = Path(temp)
        appdir = stage / 'Yeyu.AppDir'
        subprocess.run(['dpkg-deb', '-x', str(deb), str(appdir)], check=True)
        exe = appdir / 'usr/bin/yeyu'
        data = exe.read_bytes()
        prefix = b'__TAURI_BUNDLE_TYPE_VAR_'
        if data.count(prefix) != 1 or prefix + b'DEB' not in data:
            raise SystemExit('DEB 中的更新类型标记无效')
        exe.write_bytes(data.replace(prefix + b'DEB', prefix + b'APP'))
        shutil.copy2(apprun, appdir / 'AppRun')
        (appdir / 'Yeyu.desktop').symlink_to('usr/share/applications/Yeyu.desktop')
        icon = 'usr/share/icons/hicolor/128x128/apps/yeyu.png'
        if not (appdir / icon).is_file():
            raise SystemExit('DEB 缺少桌面图标')
        (appdir / 'yeyu.png').symlink_to(icon)
        (appdir / '.DirIcon').symlink_to('yeyu.png')
        stage_gtk(stage, appdir, gtk, triplet)
        subprocess.run([sys.executable, str(Path(__file__).with_name('prepare-linux-appimage.py')), str(appdir)], check=True)
        metadata = appdir / 'usr/share/metainfo/io.yeyu.markdown.appdata.xml'
        subprocess.run(['appstreamcli', 'validate', '--no-net', '--pedantic', str(metadata)], check=True)

        # appimagetool 的 xz 默认块只有 16 KiB。较大的块让 WebKitGTK 的重复数据参与同一次压缩。
        runtime = os.environ.get('YEYU_APPIMAGE_RUNTIME')
        tool = os.environ.get('YEYU_APPIMAGETOOL', 'appimagetool')
        arguments = ['--runtime-file', runtime] if runtime else []
        pending = stage / output.name
        # 已用 AppStream 严格离线校验元数据，打包器无需再向外站访问说明链接。
        subprocess.run([tool, '--no-appstream', '--comp', 'xz', '--mksquashfs-opt=-b', '--mksquashfs-opt=1M',
                        *arguments, str(appdir), str(pending)], check=True,
                       env=os.environ | {'ARCH': machine})
        pending.replace(output)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('用法为 python3 scripts/package-linux-appimage.py <DEB> <输出 AppImage>')
    package(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
