/**
 * 定时任务（Automation）调度器
 *
 * 核心设计（见 .context/plan/automation-feature.md）：
 * - 用「下次触发时间戳 + 短 tick 轮询」而非长 setInterval，避免系统休眠导致的定时器漂移
 * - 子会话归属按 sessionMode 决定：
 *     · daily（默认）：同一自然日内的触发复用同一个子会话，跨日自动新建（兼顾上下文连续性与成本控制）。
 *       叠加安全阀：同日若上次会话上下文占用率已达 DAILY_CONTEXT_ROLLOVER_THRESHOLD，本次也主动新建，
 *       避免运行刚开始就触发 SDK 自动压缩。
 *     · reuse：始终复用同一个子会话（用户主动选择，长期 token 成本由用户承担）
 * - 强制 bypassPermissions，否则无人值守时写操作会因权限弹窗永久阻塞
 * - 来源会话/目标会话忙时跳过本轮，不排队堆积
 * - 连续失败达上限自动暂停
 * - 启动时恢复：已过期的 nextRunAt 顺延到下一个完整间隔，避免重启雪崩触发
 */

import { BrowserWindow } from 'electron'
import {
  AUTOMATION_MAX_CONSECUTIVE_FAILURES,
  AUTOMATION_IPC_CHANNELS,
  AUTOMATION_DEFAULT_SESSION_MODE,
  type AgentSessionMeta,
  type Automation,
  type AutomationRun,
} from '@proma/shared'
import {
  listAutomations,
  getAutomation,
  appendRun,
  updateAutomation,
  setNextRunAt,
  setLastSessionId,
  computeNextRunAt,
} from './automation-manager'
import { createAgentSession, updateAgentSessionMeta, getAgentSessionMeta } from './agent-session-manager'
import { getSessionContextUsageRatio } from './agent-session-usage'
import { runAgentHeadless, isAgentSessionActive } from './agent-service'
import { notifyAutomationRunFinished } from './automation-notification-service'
import { getWorkspaceOperationBlockReason } from './workspace-operation-lock'

/** tick 周期：每 30s 检查一次到期任务（短轮询，抗休眠漂移） */
const TICK_INTERVAL_MS = 30_000

/** 单次任务执行的超时上限：2 小时。超时后强制标记为 error 并释放 runningAutomations 槽位 */
const RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000

/**
 * daily 模式下的上下文占用率切换阈值。
 * 当同日复用的会话上下文占用 ≥ 此值时，本次自动新建会话。
 * 留出与 SDK 自动压缩阈值（约 77.5%）的安全余量，避免本次运行刚开始就被压缩。
 */
const DAILY_CONTEXT_ROLLOVER_THRESHOLD = 0.7

/**
 * 验证上次会话是否仍完整归属于当前 Automation。
 * Automation 会话本身不是普通外部入口，不能用用户可见性代替所有权判断。
 */
function isReusableAutomationSession(session: AgentSessionMeta | undefined, automationId: string): boolean {
  if (!session || session.sourceAutomationId !== automationId) return false
  return session.sourceDesignProjectId === undefined
    && session.sourceDesignJobId === undefined
    && session.sourceCanvasProjectId === undefined
    && session.sourceCanvasId === undefined
    && session.sourceCanvasNodeId === undefined
}

/**
 * 判断两个时间戳是否落在同一个本地自然日。
 * 用 new Date().getFullYear/Month/Date 直接取本地时区年月日，避免引入时区库或字符串解析。
 */
function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

function formatWeekdays(days?: number[]): string {
  const normalized = [...new Set(days ?? [])].sort((a, b) => a - b)
  if (normalized.length === 0) return '每天'
  if (normalized.join(',') === '1,2,3,4,5') return '工作日'
  if (normalized.join(',') === '0,6') return '周末'
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return normalized.map((day) => names[day] ?? '').join('、')
}

function formatScheduleLabel(a: Automation): string {
  if (a.scheduleType === 'once') {
    const when = a.scheduledAt
      ? new Date(a.scheduledAt).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : '指定时间'
    return `仅运行一次（${when}）`
  }
  if (a.scheduleType === 'daily') return `每天 ${a.timeOfDay ?? '09:00'}`
  if (a.scheduleType === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${names[a.dayOfWeek ?? 1]} ${a.timeOfDay ?? '09:00'}`
  }
  if (a.scheduleType === 'monthly') return `每月 ${a.dayOfMonth ?? 1} 号 ${a.timeOfDay ?? '09:00'}`
  const min = a.intervalMinutes
  const intervalLabel = min < 60 ? `每 ${min} 分钟` : min < 1440 ? `每 ${min / 60} 小时` : `每 ${min / 1440} 天`
  const weekdayLabel = a.activeWeekdays && a.activeWeekdays.length > 0 ? `，${formatWeekdays(a.activeWeekdays)}` : ''
  const windowLabel = a.activeWindowStart && a.activeWindowEnd ? `，${a.activeWindowStart}–${a.activeWindowEnd}` : ''
  return `${intervalLabel}${weekdayLabel}${windowLabel}`
}

let tickTimer: NodeJS.Timeout | undefined
/** 正在执行的 Automation 与其启动时工作区归属，兼顾防重入和迁移预检。 */
const runningAutomations = new Map<string, string | undefined>()

/** 是否存在正在调度或执行的 Automation，供数据根迁移二次预检。 */
export function hasRunningAutomations(): boolean {
  return runningAutomations.size > 0
}

/** 查询指定工作区是否存在真实运行中的 Automation。 */
export function hasRunningAutomationForWorkspace(workspaceId: string): boolean {
  for (const runningWorkspaceId of runningAutomations.values()) {
    if (runningWorkspaceId === workspaceId) return true
  }
  return false
}

/** 向所有渲染窗口广播任务列表变更，触发前端刷新 */
export function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    }
  }
}

/** 执行单个 Automation 收尾副作用，避免外部 I/O 异常阻断运行槽释放。 */
function runFinishEffect(
  automationName: string,
  effectName: string,
  effect: () => void,
): void {
  try {
    effect()
  } catch (error) {
    console.error(`[定时任务] ${effectName}失败: ${automationName}`, error)
  }
}

/**
 * 执行一次定时任务：新建子会话 + headless 运行
 *
 * @param automation 任务定义
 * @param manual 是否手动「立即运行」（手动运行也走同一路径，但不影响调度计时由 appendRun 统一推进）
 */
export async function runAutomation(automation: Automation, manual = false): Promise<void> {
  if (runningAutomations.has(automation.id)) {
    console.log(`[定时任务] ${automation.name} 上一轮尚未结束，跳过本轮`)
    appendRun(automation.id, {
      runAt: Date.now(),
      sessionId: '',
      status: 'skipped',
      skipReason: '上一轮尚未结束',
    })
    broadcastChanged()
    return
  }

  /** 当前 Automation 工作区的迁移阻断原因。 */
  const workspaceBlockReason = automation.workspaceId
    ? getWorkspaceOperationBlockReason(automation.workspaceId)
    : undefined
  if (workspaceBlockReason) {
    appendRun(automation.id, {
      runAt: Date.now(),
      sessionId: '',
      status: 'skipped',
      skipReason: workspaceBlockReason,
    })
    broadcastChanged()
    return
  }

  runningAutomations.set(automation.id, automation.workspaceId)
  const runAt = Date.now()

  try {
    // 根据 sessionMode 决定新建或复用子会话
    //  - reuse：lastSessionId 存在且会话还活着就复用，否则新建
    //  - daily：再叠加一层「同一自然日」+「上下文占用率 < 阈值」双重判断
    //    （基于 automation.lastRunAt 排除 skipped 运行；占用率读不到时按"未知"保守复用）
    const sessionMode = automation.sessionMode ?? AUTOMATION_DEFAULT_SESSION_MODE

    let reuseSessionId: string | undefined
    const lastSessionMeta = automation.lastSessionId ? getAgentSessionMeta(automation.lastSessionId) : undefined
    // 已被用户手动接管（毕业）的会话不再复用，强制新建，避免把定时任务消息注入用户的私人会话
    if (lastSessionMeta?.automationGraduated) {
      console.log(`[定时任务] ${automation.name} 上次会话已被用户接管，本次自动开新会话`)
    }
    const ownsReusableSession = isReusableAutomationSession(lastSessionMeta, automation.id)
    if (automation.lastSessionId && lastSessionMeta && !lastSessionMeta.automationGraduated && ownsReusableSession) {
      if (lastSessionMeta.workspaceId !== automation.workspaceId) {
        console.warn(`[定时任务] ${automation.name} 上次会话项目已变化，本次自动开新会话`)
      } else if (sessionMode === 'reuse') {
        reuseSessionId = automation.lastSessionId
      } else if (
        sessionMode === 'daily' &&
        automation.lastRunAt &&
        isSameLocalDay(automation.lastRunAt, runAt)
      ) {
        const usageRatio = getSessionContextUsageRatio(automation.lastSessionId)
        if (usageRatio === undefined || usageRatio < DAILY_CONTEXT_ROLLOVER_THRESHOLD) {
          reuseSessionId = automation.lastSessionId
        } else {
          console.log(
            `[定时任务] ${automation.name} 上下文占用 ${(usageRatio * 100).toFixed(1)}% 已达阈值 ${DAILY_CONTEXT_ROLLOVER_THRESHOLD * 100}%，本次自动开新会话`,
          )
        }
      }
    }

    let targetSessionId: string
    if (reuseSessionId) {
      targetSessionId = reuseSessionId
    } else {
      const created = createAgentSession(automation.name, automation.channelId, automation.workspaceId, automation.modelId)
      updateAgentSessionMeta(created.id, { sourceAutomationId: automation.id })
      targetSessionId = created.id
      setLastSessionId(automation.id, created.id)
    }


    await new Promise<void>((resolveRun) => {
      let settled = false
      const finish = (status: 'success' | 'error', error?: string): void => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        const run: AutomationRun = {
          runAt,
          sessionId: targetSessionId,
          status,
          durationMs: Date.now() - runAt,
          error,
        }
        try {
          runFinishEffect(automation.name, '写入运行历史', () => appendRun(automation.id, run))
          runFinishEffect(automation.name, '广播运行状态', broadcastChanged)
          runFinishEffect(automation.name, '启动完成通知', () => {
            void notifyAutomationRunFinished({ automation, run }).catch((notifyError) => {
              console.error(`[定时任务] 发送完成通知失败: ${automation.name}`, notifyError)
            })
          })

          /** 持久化完成后重新读取的失败退避状态。 */
          let latest: Automation | undefined
          runFinishEffect(automation.name, '读取失败退避状态', () => {
            latest = getAutomation(automation.id)
          })
          if (
            latest &&
            latest.active &&
            (latest.consecutiveFailures ?? 0) >= AUTOMATION_MAX_CONSECUTIVE_FAILURES
          ) {
            runFinishEffect(automation.name, '自动暂停失败任务', () => {
              updateAutomation({ id: automation.id, active: false })
              console.warn(`[定时任务] ${automation.name} 连续失败 ${latest?.consecutiveFailures} 次，已自动暂停`)
            })
            runFinishEffect(automation.name, '广播自动暂停状态', broadcastChanged)
          }
        } finally {
          resolveRun()
        }
      }

      // 超时保护：防止 runAgentHeadless 永远不回调导致 automation 永久卡死
      const timeoutTimer = setTimeout(() => {
        finish('error', `执行超时（超过 ${RUN_TIMEOUT_MS / 3600_000} 小时）`)
        console.warn(`[定时任务] ${automation.name} 执行超时，强制结束`)
      }, RUN_TIMEOUT_MS)

      runAgentHeadless(
        {
          sessionId: targetSessionId,
          userMessage: automation.prompt + '\n<!--PROMA_SCHEDULED_RUN-->',
          automationContext: `这是 Proma 定时任务「${automation.name}」的自动执行（ID: ${automation.id}，${formatScheduleLabel(automation)}）。这本身就是定时任务，不要建议用户再创建定时任务。直接执行任务即可。如发现本任务连续失败、输出价值低、频率不合适或提示词不完整，可以使用 automation 工具读取并更新当前任务。`,
          channelId: automation.channelId,
          modelId: automation.modelId,
          workspaceId: automation.workspaceId,
          permissionModeOverride: automation.permissionMode ?? 'bypassPermissions',
          triggeredBy: 'automation',
          startedAt: runAt,
        },
        {
          source: 'bridge',
          onError: (error) => finish('error', error),
          onComplete: () => finish('success'),
          onTitleUpdated: () => { /* 子会话标题不需要特殊处理 */ },
        },
      ).catch((err) => {
        finish('error', err instanceof Error ? err.message : '未知错误')
      })
    })
  } catch (err) {
    console.error(`[定时任务] ${automation.name} 执行异常:`, err)
    const run: AutomationRun = {
      runAt,
      sessionId: '',
      status: 'error',
      durationMs: Date.now() - runAt,
      error: err instanceof Error ? err.message : '未知错误',
    }
    appendRun(automation.id, run)
    broadcastChanged()
    void notifyAutomationRunFinished({ automation, run }).catch((notifyError) => {
      console.error(`[定时任务] 发送异常通知失败: ${automation.name}`, notifyError)
    })
  } finally {
    runningAutomations.delete(automation.id)
  }
}

/** 立即运行一次（手动触发，不影响调度计时之外的逻辑） */
export async function runAutomationNow(id: string): Promise<void> {
  const automation = getAutomation(id)
  if (!automation) throw new Error(`定时任务不存在: ${id}`)
  // 草稿态（缺 channelId / workspaceId）拒绝运行，兜底前端 disabled 防止 IPC 绕过
  if (!automation.channelId || !automation.workspaceId) {
    throw new Error('请先为该任务配置模型与项目')
  }
  await runAutomation(automation, true)
}

/** 一个 tick：扫描所有 active 且到期的任务并触发 */
function tick(): void {
  const now = Date.now()
  for (const automation of listAutomations()) {
    if (!automation.active) continue
    // 完整度兜底：老用户可能存在「active=true 但缺工作区 / 渠道」的历史数据，跳过避免运行时崩溃
    if (!automation.channelId || !automation.workspaceId) continue
    if (now < automation.nextRunAt) continue
    if (runningAutomations.has(automation.id)) continue
    // 来源会话忙时跳过（极端情况下的额外保险，主要靠新建子会话规避）
    if (automation.sourceSessionId && isAgentSessionActive(automation.sourceSessionId)) {
      continue
    }
    // 不 await，让多个任务可以并行触发；各自有 runningAutomations 重入保护
    void runAutomation(automation)
  }
}

/**
 * 启动调度器
 *
 * 恢复策略：把已过期的 nextRunAt 顺延到「现在 + 一个完整间隔」，
 * 避免应用重启后一堆历史任务在同一 tick 内雪崩触发。
 */
export function startScheduler(): void {
  if (tickTimer) return
  const now = Date.now()
  for (const automation of listAutomations()) {
    if (automation.active && automation.nextRunAt <= now) {
      setNextRunAt(automation.id, computeNextRunAt(automation, now))
    }
  }
  tickTimer = setInterval(tick, TICK_INTERVAL_MS)
  console.log(`[定时任务] 调度器已启动，tick 周期 ${TICK_INTERVAL_MS / 1000}s`)
}

/** 停止调度器（before-quit 调用） */
export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = undefined
    console.log('[定时任务] 调度器已停止')
  }
}
