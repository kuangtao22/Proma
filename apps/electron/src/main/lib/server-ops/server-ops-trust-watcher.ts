import { lstatSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'

/** 监听失败必须阻断当前连接；不降级为无人维护的后台流。 */
export interface ServerOpsTrustWatcherOptions {
  configDir: string
  reconcile(): void
  unavailable(): void
}

/** 同时观察父目录与信任文件目录，目录换位也会失效；返回幂等清理函数。 */
export function watchServerOpsTrust(options: ServerOpsTrustWatcherOptions): () => void {
  /** 绑定监听创建时的目录身份，避免目录换位后继续监听旧 inode。 */
  const directory = join(options.configDir, 'server-ops')
  const identity = lstatSync(directory)
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('SERVER_OPS_TRUST_WATCH_UNAVAILABLE')
  /** 两个窄 watcher 只处理相关配置变化，无后台轮询。 */
  const watchers: FSWatcher[] = []
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    for (const watcher of watchers) watcher.close()
  }
  /** 任一监听丢失后立即终止旧连接，等待重启重新建立可信监听。 */
  const fail = (): void => {
    if (closed) return
    close()
    options.unavailable()
  }
  /** 先复核目录身份，再让 Connection Service 对账当前资产和指纹。 */
  const reconcile = (): void => {
    if (closed) return
    try {
      const current = lstatSync(directory)
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return fail()
      options.reconcile()
    } catch { fail() }
  }
  try {
    watchers.push(watch(directory, { persistent: false }, (_event, fileName) => {
      if (!fileName || fileName === 'hosts.json' || fileName === 'known-hosts.json' || fileName === 'server-ops') reconcile()
    }))
    watchers.push(watch(options.configDir, { persistent: false }, (_event, fileName) => {
      if (!fileName || fileName === 'server-ops') reconcile()
    }))
    for (const watcher of watchers) watcher.on('error', fail)
    reconcile()
    if (closed) throw new Error('SERVER_OPS_TRUST_WATCH_UNAVAILABLE')
    return close
  } catch {
    close()
    throw new Error('SERVER_OPS_TRUST_WATCH_UNAVAILABLE')
  }
}
