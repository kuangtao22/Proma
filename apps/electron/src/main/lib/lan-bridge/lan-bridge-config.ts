/**
 * LAN Bridge 配置管理
 *
 * 读写 ~/.proma/lan-bridge.json
 */

import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { writeJsonFileAtomic, readJsonFileSafe } from '../safe-file'
import { DEFAULT_LAN_BRIDGE_CONFIG } from '@proma/shared'
import type { LanBridgeConfig } from '@proma/shared'

const CONFIG_FILENAME = 'lan-bridge.json'

function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILENAME)
}

/** 获取 LAN Bridge 配置 */
export function getLanBridgeConfig(): LanBridgeConfig {
  const config = readJsonFileSafe<Partial<LanBridgeConfig>>(getConfigPath())
  return config ? { ...DEFAULT_LAN_BRIDGE_CONFIG, ...config } : { ...DEFAULT_LAN_BRIDGE_CONFIG }
}

/** 更新 LAN Bridge 配置（合并） */
export function updateLanBridgeConfig(updates: Partial<LanBridgeConfig>): LanBridgeConfig {
  const current = getLanBridgeConfig()
  const updated = { ...current, ...updates }
  writeJsonFileAtomic(getConfigPath(), updated)
  return updated
}
