import type { LanBridgeRuntimeState } from '@proma/shared'
import type { AgentEventBus } from '../agent-event-bus'

/** LAN Bridge 恢复控制器依赖，仅描述现有服务生命周期。 */
export interface LanBridgeRecoveryDependencies {
  /** 返回配置是否启用。 */
  isEnabled: () => boolean
  /** 返回当前运行状态。 */
  getStatus: () => LanBridgeRuntimeState['status']
  /** 返回当前正在使用的 EventBus；cleanup 后可能为空。 */
  getActiveEventBus: () => AgentEventBus | null
  /** 停止并清理当前 LAN Bridge。 */
  stop: () => void
  /** 使用捕获的 EventBus 重新启动 LAN Bridge。 */
  start: (bus?: AgentEventBus) => Promise<void>
}

/** LAN Bridge 恢复控制器对注册表暴露的最小接口。 */
export interface LanBridgeRecoveryController {
  /** 记住最近一次明确传入的 EventBus。 */
  rememberEventBus: (bus?: AgentEventBus) => void
  /** 判断当前是否需要错误恢复。 */
  needsRecovery: () => boolean
  /** 按停止、启动顺序完成一次恢复。 */
  recover: () => Promise<void>
}

/** 创建单个 LAN Bridge 使用的恢复状态控制器。 */
export function createLanBridgeRecoveryController(
  dependencies: LanBridgeRecoveryDependencies,
): LanBridgeRecoveryController {
  let rememberedEventBus: AgentEventBus | null = null

  return {
    rememberEventBus: (bus) => {
      if (bus) rememberedEventBus = bus
    },
    needsRecovery: () => dependencies.isEnabled() && dependencies.getStatus() === 'error',
    recover: async () => {
      // stop 会清空 active 引用，因此必须先捕获并持久记住本次恢复使用的 bus。
      const recoveryEventBus = dependencies.getActiveEventBus() ?? rememberedEventBus ?? undefined
      if (recoveryEventBus) rememberedEventBus = recoveryEventBus
      dependencies.stop()
      await dependencies.start(recoveryEventBus)
    },
  }
}
