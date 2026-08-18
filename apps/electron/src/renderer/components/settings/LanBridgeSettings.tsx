/**
 * LanBridgeSettings - 局域网 Bridge 设置面板
 *
 * 内嵌 WS Server，让第三方客户端（lan-viewer、Web UI 等）接入 Proma。
 * PIN 配对认证，局域网内安全访问。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { Copy, Loader2, Power, PowerOff, QrCode, RefreshCw, ShieldCheck, Smartphone, Trash2, Wifi } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsRow } from './primitives/SettingsRow'
import { SettingsInput } from './primitives/SettingsInput'
import { lanBridgeStateAtom, lanBridgeConfigAtom } from '@/atoms/lan-bridge-atoms'
import {
  createLanBridgeSettingsRequestCoordinator,
  getPairingCountdown,
  removeRevokedDevice,
  shouldRunPairingCountdown,
} from './lan-bridge-settings-logic'
import type {
  LanBridgeConfig,
  LanBridgeDeviceDto,
  LanBridgeGetPairingQrResponse,
  LanBridgeRuntimeState,
} from '@proma/shared'

const STATUS_CONFIG: Record<LanBridgeRuntimeState['status'], { color: string; label: string }> = {
  stopped: { color: 'bg-gray-400', label: '已停止' },
  starting: { color: 'bg-amber-400 animate-pulse', label: '启动中...' },
  running: { color: 'bg-green-500', label: '运行中' },
  error: { color: 'bg-red-500', label: '启动失败' },
}

export function LanBridgeSettings(): React.ReactElement {
  const [runtimeState, setRuntimeState] = useAtom(lanBridgeStateAtom)
  const [config, setConfig] = useAtom(lanBridgeConfigAtom)
  const [loaded, setLoaded] = React.useState(false)
  const [pin, setPin] = React.useState('')
  const [portInput, setPortInput] = React.useState(String(config.port))
  const [maxConnInput, setMaxConnInput] = React.useState(String(config.maxConnections))
  const [saving, setSaving] = React.useState(false)
  const [pairingQr, setPairingQr] = React.useState<LanBridgeGetPairingQrResponse | null>(null)
  const [pairingLoading, setPairingLoading] = React.useState(false)
  const [pairingError, setPairingError] = React.useState('')
  const [devices, setDevices] = React.useState<LanBridgeDeviceDto[]>([])
  const [devicesLoading, setDevicesLoading] = React.useState(false)
  const [devicesError, setDevicesError] = React.useState('')
  const [revokingDeviceId, setRevokingDeviceId] = React.useState<string | null>(null)
  const [now, setNow] = React.useState(Date.now())
  /** 按资源 generation 隔离乱序 IPC，并统一处理 stop/restart/unmount。 */
  const requestCoordinator = React.useMemo(createLanBridgeSettingsRequestCoordinator, [])

  /** 获取新的短期二维码；旧票据按 AuthService 语义自然保留至短 TTL。 */
  const loadPairingQr = React.useCallback(async () => {
    await requestCoordinator.run('pairingQr', () => window.electronAPI.getLanBridgePairingQr(), {
      onStart: () => {
        setPairingLoading(true)
        setPairingError('')
      },
      onSuccess: (response) => {
        /** 主进程只返回二维码图像和失效时间，不向 renderer 暴露票据。 */
        setPairingQr(response)
        setNow(Date.now())
      },
      onError: (error) => {
        setPairingQr(null)
        setPairingError(error instanceof Error ? error.message : '无法生成配对二维码')
      },
      onSettled: () => setPairingLoading(false),
    })
  }, [requestCoordinator])

  /** 加载当前仍有访问权的设备列表。 */
  const loadDevices = React.useCallback(async () => {
    await requestCoordinator.run('devicesList', () => window.electronAPI.listLanBridgeDevices(), {
      onStart: () => {
        setDevicesLoading(true)
        setDevicesError('')
      },
      /** 默认不包含已撤销设备，保持界面与有效权限一致。 */
      onSuccess: response => setDevices(response.devices),
      onError: error => setDevicesError(
        error instanceof Error ? error.message : '无法加载授权设备',
      ),
      onSettled: () => setDevicesLoading(false),
    }, { resultScope: 'devices' })
  }, [requestCoordinator])

  /** 卸载后永久废弃所有迟到 IPC 回调。 */
  React.useEffect(() => () => requestCoordinator.unmount(), [requestCoordinator])

  // 加载配置和状态
  React.useEffect(() => {
    Promise.all([
      window.electronAPI.getLanBridgeConfig(),
      window.electronAPI.getLanBridgeStatus(),
    ]).then(([cfg, state]) => {
      setConfig(cfg)
      setRuntimeState(state)
      setPortInput(String(cfg.port))
      setMaxConnInput(String(cfg.maxConnections))
    }).catch((error: unknown) => {
      toast.error(`加载局域网 Bridge 设置失败: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => setLoaded(true))
  }, [setConfig, setRuntimeState])

  // 订阅状态变化
  React.useEffect(() => {
    const unsubscribe = window.electronAPI.onLanBridgeStatusChanged((state: LanBridgeRuntimeState) => {
      setRuntimeState(state)
    })
    return unsubscribe
  }, [setRuntimeState])

  // 获取 PIN
  React.useEffect(() => {
    /** running 变化提升 lifecycle epoch，旧 stop/restart 请求无法回写。 */
    const isRunningNow = runtimeState.status === 'running'
    requestCoordinator.setRunning(isRunningNow)
    if (isRunningNow) {
      void requestCoordinator.run('pin', () => window.electronAPI.getLanBridgePin(), {
        onStart: () => undefined,
        onSuccess: setPin,
        onError: () => setPin(''),
        onSettled: () => undefined,
      })
      void loadPairingQr()
      void loadDevices()
      return
    }
    setPin('')
    setPairingQr(null)
    setPairingError('')
    setPairingLoading(false)
    setDevices([])
    setDevicesError('')
    setDevicesLoading(false)
    setRevokingDeviceId(null)
  }, [runtimeState.status, loadPairingQr, loadDevices, requestCoordinator])

  /** 二维码存在时每秒刷新一次剩余时间，不触发网络请求。 */
  React.useEffect(() => {
    if (!pairingQr || !shouldRunPairingCountdown(pairingQr.expiresAt, Date.now())) return
    /** 到期 tick 内立即停止 interval；新二维码会通过依赖变化重新启动。 */
    const timer = window.setInterval(() => {
      /** 当前 tick 时间同时用于展示与是否继续调度的判定。 */
      const currentNow = Date.now()
      setNow(currentNow)
      if (!shouldRunPairingCountdown(pairingQr.expiresAt, currentNow)) {
        window.clearInterval(timer)
      }
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [pairingQr])

  // 启动服务
  const handleStart = React.useCallback(async () => {
    try {
      await window.electronAPI.startLanBridge()
      toast.success('局域网 Bridge 已启动')
    } catch (error) {
      toast.error(`启动失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  // 停止服务
  const handleStop = React.useCallback(async () => {
    try {
      await window.electronAPI.stopLanBridge()
      setPin('')
      toast.info('局域网 Bridge 已停止')
    } catch (error) {
      toast.error(`停止失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  // 刷新 PIN
  const handleRefreshPin = React.useCallback(async () => {
    await requestCoordinator.run('pin', () => window.electronAPI.refreshLanBridgePin(), {
      onStart: () => undefined,
      onSuccess: (newPin) => {
        setPin(newPin)
        toast.success('PIN 码已刷新')
      },
      onError: error => toast.error(
        `刷新失败: ${error instanceof Error ? error.message : String(error)}`,
      ),
      onSettled: () => undefined,
    })
  }, [requestCoordinator])

  /** 撤销指定设备；IPC 成功后立即同步本地列表，避免等待下一次刷新。 */
  const handleRevokeDevice = React.useCallback(async (deviceId: string) => {
    if (revokingDeviceId) return
    await requestCoordinator.run('deviceRevoke', () => (
      window.electronAPI.revokeLanBridgeDevice({ deviceId })
    ), {
      onStart: () => setRevokingDeviceId(deviceId),
      onSuccess: () => {
        /** 撤销完成后废弃所有更早的设备列表结果。 */
        requestCoordinator.invalidateResults('devices')
        setDevices(current => removeRevokedDevice(current, deviceId))
        toast.success('设备访问权已撤销')
        /** 重新读取主进程权威列表，覆盖撤销期间可能出现的其他设备变化。 */
        void loadDevices()
      },
      onError: error => toast.error(
        `撤销失败: ${error instanceof Error ? error.message : String(error)}`,
      ),
      onSettled: () => setRevokingDeviceId(null),
    })
  }, [loadDevices, revokingDeviceId, requestCoordinator])

  // 保存配置
  const handleSaveConfig = React.useCallback(async () => {
    const port = Number(portInput)
    const maxConnections = Number(maxConnInput)
    if (isNaN(port) || port < 1024 || port > 65535) {
      toast.error('端口范围: 1024-65535')
      return
    }
    if (isNaN(maxConnections) || maxConnections < 1 || maxConnections > 50) {
      toast.error('最大连接数范围: 1-50')
      return
    }
    setSaving(true)
    try {
      const updated = await window.electronAPI.updateLanBridgeConfig({ port, maxConnections })
      setConfig(updated)
      toast.success('配置已保存')
    } catch (error) {
      toast.error(`保存失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }, [portInput, maxConnInput, setConfig])

  // 复制到剪贴板
  const copyToClipboard = React.useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success('已复制'))
  }, [])

  const statusConfig = STATUS_CONFIG[runtimeState.status]
  const isRunning = runtimeState.status === 'running'
  /** 当前二维码倒计时状态。 */
  const pairingCountdown = pairingQr ? getPairingCountdown(pairingQr.expiresAt, now) : null

  if (!loaded) return <div />

  return (
    <div className="space-y-8">
      {/* 服务状态 */}
      <SettingsSection
        title="局域网 Bridge"
        description="在局域网内暴露 WebSocket 接口，允许第三方客户端接入 Proma"
      >
        <SettingsCard>
          <SettingsRow label="服务状态">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${statusConfig.color}`} />
                <span className="text-sm text-muted-foreground">{statusConfig.label}</span>
              </div>
              {isRunning ? (
                <Button size="sm" variant="outline" onClick={handleStop}>
                  <PowerOff size={14} className="mr-1.5" />
                  停止
                </Button>
              ) : (
                <Button size="sm" onClick={handleStart} disabled={runtimeState.status === 'starting'}>
                  {runtimeState.status === 'starting' ? (
                    <Loader2 size={14} className="animate-spin mr-1.5" />
                  ) : (
                    <Power size={14} className="mr-1.5" />
                  )}
                  启动
                </Button>
              )}
            </div>
          </SettingsRow>
        </SettingsCard>

        {/* 错误信息 */}
        {runtimeState.status === 'error' && runtimeState.errorMessage && (
          <div className="mt-2 px-3 py-2.5 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm">
            {runtimeState.errorMessage}
          </div>
        )}
      </SettingsSection>

      {/* 扫码配对 */}
      {isRunning && (
        <SettingsSection
          title="扫码配对"
          description="手机连接同一局域网后扫码，一次授权即可进入 Proma"
          action={(
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => void loadPairingQr()}
                  disabled={pairingLoading}
                  aria-label="刷新配对二维码"
                >
                  {pairingLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新配对二维码</TooltipContent>
            </Tooltip>
          )}
        >
          <SettingsCard divided={false}>
            <div className="flex min-h-[244px] flex-wrap items-center justify-center gap-4 px-4 py-4 sm:justify-start sm:gap-6">
              <div className="flex aspect-square w-full max-w-[212px] shrink-0 items-center justify-center rounded-lg border border-border/60 bg-white p-2">
                {pairingLoading && !pairingQr ? (
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="正在生成二维码" />
                ) : pairingQr ? (
                  <img
                    src={pairingQr.qrCodeData}
                    alt="Proma 手机端一次性配对二维码"
                    className={`h-full w-full object-contain ${pairingCountdown?.expired ? 'opacity-25' : ''}`}
                  />
                ) : (
                  <QrCode className="h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
                )}
              </div>
              <div className="w-full min-w-0 flex-1 space-y-2 sm:w-auto">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Smartphone size={16} />
                  手机扫码连接
                </div>
                {pairingError ? (
                  <div className="space-y-2" role="alert">
                    <p className="text-sm text-destructive">{pairingError}</p>
                    <Button size="sm" variant="outline" onClick={() => void loadPairingQr()}>
                      重试
                    </Button>
                  </div>
                ) : pairingCountdown?.expired ? (
                  <div className="space-y-2">
                    <p className="text-sm text-destructive">二维码已过期</p>
                    <Button size="sm" variant="outline" onClick={() => void loadPairingQr()}>
                      <RefreshCw size={14} className="mr-1.5" />
                      生成新二维码
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">使用手机相机或浏览器扫码</p>
                    <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                      {pairingCountdown ? `剩余 ${pairingCountdown.label}` : '正在准备...'}
                    </p>
                  </>
                )}
              </div>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* PIN 码 */}
      {isRunning && (
        <SettingsSection
          title="手工 / 第三方连接"
          description="无法扫码或使用自研客户端时，通过 PIN 完成手工配对"
        >
          <SettingsCard>
            <SettingsRow label="当前 PIN">
              <div className="flex items-center gap-3">
                <span className="text-2xl font-mono font-bold tracking-[0.5em] text-foreground select-all">
                  {pin || '------'}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleRefreshPin} aria-label="刷新 PIN 码">
                      <RefreshCw size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>刷新 PIN 码</TooltipContent>
                </Tooltip>
              </div>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 已授权设备 */}
      {isRunning && (
        <SettingsSection
          title="授权设备"
          description="这些设备持有仍有效的本机访问权"
          action={(
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => void loadDevices()}
                  disabled={devicesLoading}
                  aria-label="刷新授权设备"
                >
                  {devicesLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新授权设备</TooltipContent>
            </Tooltip>
          )}
        >
          {devicesLoading && devices.length === 0 ? (
            <div className="flex h-20 items-center justify-center text-muted-foreground" role="status">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : devicesError ? (
            <div className="flex items-center justify-between gap-4 py-3" role="alert">
              <p className="text-sm text-destructive">{devicesError}</p>
              <Button size="sm" variant="outline" onClick={() => void loadDevices()}>重试</Button>
            </div>
          ) : devices.length === 0 ? (
            <div className="flex h-20 flex-col items-center justify-center gap-1 text-muted-foreground">
              <ShieldCheck size={20} aria-hidden="true" />
              <p className="text-sm">暂无已授权设备</p>
            </div>
          ) : (
            <SettingsCard>
              {devices.map(device => (
                <div key={device.id} className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground" title={device.name}>
                      {device.name}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      最近访问 {formatDeviceTime(device.lastSeenAt)}
                    </p>
                  </div>
                  <div className="shrink-0">
                  <AlertDialog>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            disabled={revokingDeviceId !== null}
                            aria-label={`撤销 ${device.name} 的访问权`}
                          >
                            {revokingDeviceId === device.id
                              ? <Loader2 size={15} className="animate-spin" />
                              : <Trash2 size={15} />}
                          </Button>
                        </AlertDialogTrigger>
                      </TooltipTrigger>
                      <TooltipContent>撤销设备</TooltipContent>
                    </Tooltip>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>撤销“{device.name}”的访问权？</AlertDialogTitle>
                        <AlertDialogDescription>
                          该设备会立即断开，之后需要重新扫码或输入 PIN 才能连接。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel disabled={revokingDeviceId !== null}>取消</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          disabled={revokingDeviceId !== null}
                          onClick={() => void handleRevokeDevice(device.id)}
                        >
                          撤销访问权
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  </div>
                </div>
              ))}
            </SettingsCard>
          )}
        </SettingsSection>
      )}

      {/* 访问地址 */}
      {isRunning && (
        <SettingsSection
          title="访问地址"
          description="第三方客户端通过以下地址连接"
        >
          <SettingsCard>
            <SettingsRow label="局域网 WS">
              <div className="flex items-center gap-2">
                <code className="text-sm text-muted-foreground font-mono">
                  ws://{runtimeState.localIp}:{runtimeState.port}
                </code>
                <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => copyToClipboard(`ws://${runtimeState.localIp}:${runtimeState.port}`)}>
                  <Copy size={12} />
                </Button>
              </div>
            </SettingsRow>
            <SettingsRow label="手机端网页">
              <div className="flex items-center gap-2">
                <code className="text-sm text-primary font-mono font-semibold">
                  http://{runtimeState.localIp}:{runtimeState.port}
                </code>
                <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => copyToClipboard(`http://${runtimeState.localIp}:${runtimeState.port}`)}>
                  <Copy size={12} />
                </Button>
              </div>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 已连接设备 */}
      {isRunning && (
        <SettingsSection
          title="已连接设备"
          description={`当前 ${runtimeState.connectedClients.length} 个客户端`}
        >
          {runtimeState.connectedClients.length > 0 ? (
            <SettingsCard>
              {runtimeState.connectedClients.map((client, i) => (
                <SettingsRow key={client.id ?? i} label={client.ip}>
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${client.authenticated ? 'bg-green-500' : 'bg-amber-400'}`} />
                    <span className="text-xs text-muted-foreground">
                      {client.authenticated ? '已认证' : '未认证'}
                    </span>
                  </div>
                </SettingsRow>
              ))}
            </SettingsCard>
          ) : (
            <div className="text-sm text-muted-foreground py-3">
              暂无连接
            </div>
          )}
        </SettingsSection>
      )}

      {/* 配置 */}
      <SettingsSection
        title="服务配置"
        description="修改配置后需重启服务生效"
      >
        <SettingsCard>
          <SettingsRow label="端口">
            <SettingsInput
              value={portInput}
              onChange={setPortInput}
              placeholder="29888"
              className="w-24 text-right"
              type="number"
            />
          </SettingsRow>
          <SettingsRow label="最大连接数">
            <SettingsInput
              value={maxConnInput}
              onChange={setMaxConnInput}
              placeholder="5"
              className="w-24 text-right"
              type="number"
            />
          </SettingsRow>
        </SettingsCard>
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={handleSaveConfig} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin mr-1.5" /> : null}
            保存配置
          </Button>
        </div>
      </SettingsSection>

      {/* 使用说明 */}
      <SettingsSection
        title="使用说明"
        description="两种接入方式：内置手机端 或 对接 WS 协议"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-6 text-sm">
            {/* 方案一：内置手机端 */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-green-500/20 text-green-400 text-xs font-semibold flex items-center justify-center">📱</span>
                <span className="font-medium text-foreground">方案一：内置手机端（开箱即用）</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                手机连接同一 WiFi，浏览器打开上方「手机端网页」地址，输入 PIN 码即可使用。
                支持查看 Chat/Agent 对话、发送消息、切换模型、实时流式回复。
              </p>
              <div className="pl-7 space-y-1.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex-shrink-0 w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center">1</span>
                  <span>启动服务，获取 PIN 码</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex-shrink-0 w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center">2</span>
                  <span>手机浏览器打开 <code className="px-1 py-0.5 bg-muted rounded text-[11px]">http://{isRunning ? runtimeState.localIp : 'IP'}:{config.port}</code></span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex-shrink-0 w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center">3</span>
                  <span>输入 PIN 码，开始对话</span>
                </div>
              </div>
            </div>

            <div className="border-t border-border" />

            {/* 方案二：WS 协议对接 */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500/20 text-blue-400 text-xs font-semibold flex items-center justify-center">🔌</span>
                <span className="font-medium text-foreground">方案二：对接 WS 协议（自研客户端）</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                任何第三方（Web UI、IDE 插件、CLI 工具等）均可通过 WebSocket 协议接入 Proma，
                实现对话查询、Agent 交互、实时流式推送等全部能力。
              </p>

              {/* 认证流程 */}
              <div className="pl-7 space-y-1.5">
                <span className="text-xs font-medium text-foreground/80">认证流程</span>
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <span className="flex-shrink-0 w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center mt-0.5">1</span>
                  <span>连接 <code className="px-1 py-0.5 bg-muted rounded text-[11px]">ws://{'{'}IP{'}'}:{config.port}</code></span>
                </div>
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <span className="flex-shrink-0 w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center mt-0.5">2</span>
                  <span>发送 <code className="px-1 py-0.5 bg-muted rounded text-[11px]">{'{'} "type": "auth.pair", "data": {'{'} "pin": "123456" {'}'} {'}'}</code> 获取 Token（24h 有效）</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <span className="flex-shrink-0 w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center mt-0.5">3</span>
                  <span>后续请求在 <code className="px-1 py-0.5 bg-muted rounded text-[11px]">data</code> 中携带 <code className="px-1 py-0.5 bg-muted rounded text-[11px]">token</code></span>
                </div>
              </div>

              {/* API 列表 */}
              <div className="pl-7 space-y-1.5">
                <span className="text-xs font-medium text-foreground/80">可用命令</span>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono text-foreground/70">auth.pair / verify / refresh</span>
                  <span>认证</span>
                  <span className="font-mono text-foreground/70">conversations.list / messages</span>
                  <span>Chat 对话</span>
                  <span className="font-mono text-foreground/70">agent.sessions / messages</span>
                  <span>Agent 会话</span>
                  <span className="font-mono text-foreground/70">agent.send / stop</span>
                  <span>Agent 交互</span>
                  <span className="font-mono text-foreground/70">agent.session.create</span>
                  <span>新建会话</span>
                  <span className="font-mono text-foreground/70">workspaces.list</span>
                  <span>工作区</span>
                  <span className="font-mono text-foreground/70">settings.get / channels</span>
                  <span>设置/模型</span>
                  <span className="font-mono text-foreground/70">subscribe / unsubscribe</span>
                  <span>实时事件</span>
                  <span className="font-mono text-foreground/70">conversations.search</span>
                  <span>搜索</span>
                </div>
              </div>

              {/* 推送事件 */}
              <div className="pl-7 space-y-1.5">
                <span className="text-xs font-medium text-foreground/80">服务端推送事件（subscribe 后接收）</span>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono text-foreground/70">stream.chunk</span>
                  <span>流式文本片段</span>
                  <span className="font-mono text-foreground/70">stream.tool_start</span>
                  <span>工具调用开始</span>
                  <span className="font-mono text-foreground/70">stream.complete</span>
                  <span>流式完成</span>
                  <span className="font-mono text-foreground/70">stream.error</span>
                  <span>流式错误</span>
                  <span className="font-mono text-foreground/70">session.updated</span>
                  <span>会话元数据变更</span>
                </div>
              </div>

              {/* 消息格式 */}
              <div className="pl-7 space-y-1.5">
                <span className="text-xs font-medium text-foreground/80">消息格式</span>
                <pre className="text-[11px] text-muted-foreground bg-muted/50 rounded-lg p-2.5 overflow-x-auto leading-relaxed">{`请求: { "type": "命令", "id": "可选", "data": { "token": "..." } }
响应: { "type": "命令", "id": "...", "ok": true, "data": { ... } }
推送: { "type": "stream.chunk", "data": { "text": "..." } }`}</pre>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
              <div className="flex items-center gap-1.5 mb-1">
                <Wifi size={12} />
                <span className="font-medium">安全提示</span>
              </div>
              仅限局域网（RFC 1918 私有地址）访问，PIN + HMAC Token 双重认证，
              API Key 不会暴露给客户端。连接限制 {config.maxConnections} 个客户端。
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

/** 将设备最近访问时间格式化为紧凑、可扫描的本地时间。 */
function formatDeviceTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp)
}
