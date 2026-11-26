import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


def library_owners():
    triplet = subprocess.check_output(['dpkg-architecture', '-qDEB_HOST_MULTIARCH'], text=True).strip()
    multiarch = '/usr/lib/' + triplet + '/'
    by_path = defaultdict(set)
    by_name = defaultdict(set)
    for listing in Path('/var/lib/dpkg/info').glob('*.list'):
        package = listing.stem.split(':', 1)[0]
        copyright_file = Path('/usr/share/doc') / package / 'copyright'
        if not copyright_file.is_file():
            continue
        for entry in listing.read_text().splitlines():
            if entry.startswith(('/lib/', '/usr/lib/', '/usr/lib64/', '/usr/libexec/')):
                canonical = entry if entry.startswith('/usr/') else '/usr' + entry
                by_path[canonical].add(package)
                if canonical.startswith(multiarch):
                    by_path['/usr/lib/' + canonical.removeprefix(multiarch)].add(package)
                by_name[Path(entry).name].add(package)
    return by_path, by_name


def prepare(appdir, project):
    original_desktop = appdir / 'Yeyu.desktop'
    desktop = appdir / 'io.yeyu.markdown.desktop'
    if not (appdir / 'usr/bin/yeyu').is_file() or not (original_desktop.is_file() or desktop.is_file()):
        raise SystemExit('请选择从页屿 AppImage 解包得到的目录')
    by_path, by_name = library_owners()
    packages = set()
    missing = []
    for directory in ('usr/lib', 'usr/lib64', 'usr/libexec'):
        for entry in (appdir / directory).rglob('*'):
            if entry.is_symlink() or not entry.is_file():
                continue
            with entry.open('rb') as file:
                if file.read(4) != b'\x7fELF':
                    continue
            # linuxdeploy 会把多架构目录中的库放入 usr/lib。按原路径查找，再匹配唯一的包名。
            owned_by = by_path.get('/' + entry.relative_to(appdir).as_posix()) or by_name.get(entry.name)
            if not owned_by or len(owned_by) != 1:
                missing.append(entry.relative_to(appdir).as_posix())
                continue
            packages.update(owned_by)
    if missing:
        raise SystemExit('无法确认随包发布的库所属的 Debian 包\n' + '\n'.join(sorted(missing)))

    docs = appdir / 'usr/share/doc'
    for package in sorted(packages):
        target = docs / package / 'copyright'
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path('/usr/share/doc') / package / 'copyright', target)
    # Debian 的版权文件会引用这些许可证正文，打包时一并带上。
    shutil.copytree('/usr/share/common-licenses', appdir / 'usr/share/common-licenses', dirs_exist_ok=True)
    (docs / 'yeyu').mkdir(parents=True, exist_ok=True)
    shutil.copyfile(project / 'LICENSE', docs / 'yeyu/copyright')
    # appimagetool 用桌面文件名找元数据，AppStream 又要求该文件名与应用标识一致。
    if original_desktop.is_file():
        desktop_entry = Path('usr/share/applications') / desktop.name
        (appdir / 'usr/share/applications/Yeyu.desktop').rename(appdir / desktop_entry)
        original_desktop.unlink()
        desktop.symlink_to(desktop_entry)
    metadata = appdir / 'usr/share/metainfo/io.yeyu.markdown.appdata.xml'
    metadata.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(project / 'src-tauri/installer/yeyu.metainfo.xml', metadata)
    print(f'已附带页屿和 {len(packages)} 个系统依赖包的许可证')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('用法为 python3 scripts/prepare-linux-appimage.py <解包目录>')
    prepare(Path(sys.argv[1]).resolve(), Path(__file__).resolve().parents[1])
