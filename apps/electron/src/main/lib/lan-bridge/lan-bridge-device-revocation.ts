/** 设备撤销 facade 的最小依赖。 */
export interface LanBridgeDeviceRevocationDependencies<TDevice> {
  /** 原子持久化设备撤销。 */
  revokeDevice: () => TDevice | undefined
  /** 断开该设备的全部现有连接。 */
  disconnectDevice: () => void
  /** 向 renderer 推送断开后的最新状态。 */
  notifyStatusChanged: () => void
}

/** 执行设备撤销；占位实现由失败测试驱动补齐状态通知。 */
export function executeLanBridgeDeviceRevocation<TDevice>(
  dependencies: LanBridgeDeviceRevocationDependencies<TDevice>,
): TDevice | undefined {
  /** 只有原子写盘成功后才允许产生连接副作用。 */
  const device = dependencies.revokeDevice()
  if (!device) return undefined
  dependencies.disconnectDevice()
  dependencies.notifyStatusChanged()
  return device
}
