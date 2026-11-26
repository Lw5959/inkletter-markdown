import { Channel, invoke } from '@tauri-apps/api/core'
import type { PackageLaunch, UpdateOffer, UpdateProgress } from './ui/update-dialog'

export type ReleaseInfo = { version: string; notes: string }

export async function checkPublishedPackage(options: {
  beforeInstall: () => Promise<void>
  save?: (version: string) => Promise<string | null>
}): Promise<UpdateOffer | null> {
  const release = await invoke<ReleaseInfo | null>('update_check_package')
  if (!release) return null
  const { version } = release
  const save = options.save
  return {
    ...release, kind: 'package',
    apply: report => invoke('update_download_package', { version, progress: new Channel<UpdateProgress>(report) }),
    async install() {
      await options.beforeInstall()
      return invoke<PackageLaunch>('update_open_package', { version })
    },
    save: save && (() => save(version)),
  }
}
