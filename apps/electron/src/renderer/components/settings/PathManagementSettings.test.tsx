import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentType } from 'react'
import type { DataRootMigrationStatus, PathManagementState } from '@proma/shared'
import { readFileSync } from 'node:fs'
import * as migrationSettingsModule from './PathManagementSettings'

/** 设置页测试期望的新模块导出合同。 */
interface ExpectedPathManagementSettingsModule {
  createPathManagementSettingsView: (state: PathManagementState | null, error?: string) => {
    kind: 'loading' | 'ready' | 'blocked' | 'error'
    migrationBlocked: boolean
    statusLabel: string
  }
  requestDataRootMigration: (
    state: PathManagementState,
    dependencies: {
      pickDataRoot: () => Promise<string | null>
      confirmMigration: (targetRoot: string) => Promise<boolean>
      startDataRootMigration: (targetRoot: string) => Promise<void>
    },
  ) => Promise<'cancelled' | 'started'>
  getDataRootDeviceRisk: (deviceType: PathManagementState['deviceType']) => string | null
  mergePathManagementStatus: (
    state: PathManagementState,
    status: DataRootMigrationStatus,
  ) => PathManagementState
  DataRootLocationSection: ComponentType<{ state: PathManagementState }>
  CrossDeviceMigrationSection: ComponentType
}

/** RED 阶段通过可选合同读取新增导出，避免模块不存在导致测试环境错误。 */
function getExpectedModule(): ExpectedPathManagementSettingsModule {
  return migrationSettingsModule as unknown as ExpectedPathManagementSettingsModule
}

/** 创建设置页行为测试使用的完整可用状态。 */
function createState(overrides: Partial<PathManagementState> = {}): PathManagementState {
  return {
    activeRoot: '/Users/example/.proma',
    previousRoot: '/Volumes/Backup/Proma',
    availability: 'available',
    deviceType: 'local',
    occupiedBytes: 1024 * 1024,
    availableBytes: 10 * 1024 * 1024,
    migration: null,
    ...overrides,
  }
}

describe('PathManagementSettings', () => {
  test('Given 尚未取得状态或读取失败 When 派生视图 Then 分别展示 loading 与 error', () => {
    const { createPathManagementSettingsView } = getExpectedModule()
    expect(typeof createPathManagementSettingsView).toBe('function')

    expect(createPathManagementSettingsView(null)).toMatchObject({ kind: 'loading', migrationBlocked: true })
    expect(createPathManagementSettingsView(null, '无法读取路径状态')).toMatchObject({
      kind: 'error',
      statusLabel: '无法读取路径状态',
      migrationBlocked: true,
    })
  })

  test('Given pending 计划或 cleanup 未解决 When 派生视图 Then 阻断重复迁移且不误报完成', () => {
    const { createPathManagementSettingsView } = getExpectedModule()
    expect(typeof createPathManagementSettingsView).toBe('function')

    expect(createPathManagementSettingsView(createState({
      migration: {
        migrationId: 'migration-1',
        stage: 'pending',
        completedBytes: 0,
        totalBytes: 1024,
      },
    }))).toMatchObject({ kind: 'blocked', migrationBlocked: true, statusLabel: '迁移计划已创建，等待应用重启' })
    expect(createPathManagementSettingsView(createState({
      postCommitCleanup: {
        migrationId: 'migration-1',
        targetRoot: '/Volumes/New/Proma',
        status: 'failed',
        error: '目标盘离线',
      },
    }))).toMatchObject({ kind: 'blocked', migrationBlocked: true, statusLabel: '迁移已切换，但清理尚未完成：目标盘离线' })
  })

  test('Given 旧状态含 cleanup When 最新迁移状态已清除 Then 合并后移除旧 cleanup', () => {
    const { createPathManagementSettingsView, mergePathManagementStatus } = getExpectedModule()
    expect(typeof mergePathManagementStatus).toBe('function')
    /** 模拟设置页尚未刷新的旧 cleanup 状态。 */
    const staleState = createState({
      postCommitCleanup: {
        migrationId: 'migration-1',
        targetRoot: '/Volumes/New/Proma',
        status: 'pending',
      },
    })

    const merged = mergePathManagementStatus(staleState, { migration: null })

    expect(merged.postCommitCleanup).toBeUndefined()
    expect(createPathManagementSettingsView(merged).kind).toBe('ready')
  })

  test('Given 用户取消选择或确认 When 请求迁移 Then 不创建计划', async () => {
    const { requestDataRootMigration } = getExpectedModule()
    expect(typeof requestDataRootMigration).toBe('function')
    /** 记录是否越过确认直接创建计划。 */
    let started = false

    const cancelledAtPicker = await requestDataRootMigration(createState(), {
      pickDataRoot: async () => null,
      confirmMigration: async () => true,
      startDataRootMigration: async () => { started = true },
    })
    const cancelledAtDialog = await requestDataRootMigration(createState(), {
      pickDataRoot: async () => '/Volumes/New/Proma',
      confirmMigration: async () => false,
      startDataRootMigration: async () => { started = true },
    })

    expect(cancelledAtPicker).toBe('cancelled')
    expect(cancelledAtDialog).toBe('cancelled')
    expect(started).toBe(false)
  })

  test('Given 可迁移且用户确认 When 请求迁移 Then 按选择、确认、启动顺序创建计划', async () => {
    const { requestDataRootMigration } = getExpectedModule()
    expect(typeof requestDataRootMigration).toBe('function')
    /** 记录用户流程调用顺序与目标。 */
    const calls: string[] = []

    const result = await requestDataRootMigration(createState(), {
      pickDataRoot: async () => {
        calls.push('pick')
        return '/Volumes/New/Proma'
      },
      confirmMigration: async (targetRoot) => {
        calls.push(`confirm:${targetRoot}`)
        return true
      },
      startDataRootMigration: async (targetRoot) => {
        calls.push(`start:${targetRoot}`)
      },
    })

    expect(result).toBe('started')
    expect(calls).toEqual(['pick', 'confirm:/Volumes/New/Proma', 'start:/Volumes/New/Proma'])
  })

  test('Given 状态已被迁移或 cleanup 阻断 When 请求迁移 Then 不打开目录选择器', async () => {
    const { requestDataRootMigration } = getExpectedModule()
    expect(typeof requestDataRootMigration).toBe('function')
    /** 记录是否错误打开系统选择器。 */
    let picked = false
    const blockedState = createState({
      postCommitCleanup: {
        migrationId: 'migration-1',
        targetRoot: '/Volumes/New/Proma',
        status: 'pending',
      },
    })

    expect(requestDataRootMigration(blockedState, {
      pickDataRoot: async () => { picked = true; return '/Volumes/New/Proma' },
      confirmMigration: async () => true,
      startDataRootMigration: async () => undefined,
    })).rejects.toThrow('当前路径状态不允许创建新的迁移计划')
    expect(picked).toBe(false)
  })

  test('Given network 或 removable 数据根 When 生成风险 Then 显示断连或性能提醒', () => {
    const { getDataRootDeviceRisk } = getExpectedModule()
    expect(typeof getDataRootDeviceRisk).toBe('function')

    expect(getDataRootDeviceRisk('network')).toContain('断连')
    expect(getDataRootDeviceRisk('removable')).toContain('性能')
    expect(getDataRootDeviceRisk('local')).toBeNull()
  })

  test('Given 当前与上次数据根 When 渲染位置区块 Then 完整路径可访问且没有删除旧目录入口', () => {
    const { DataRootLocationSection } = getExpectedModule()
    expect(typeof DataRootLocationSection).toBe('function')
    /** 静态 HTML 锁定路径、元数据和安全操作文案。 */
    const html = renderToStaticMarkup(<DataRootLocationSection state={createState()} />)

    expect(html).toContain('Proma 数据位置')
    expect(html).toContain('/Users/example/.proma')
    expect(html).toContain('/Volumes/Backup/Proma')
    expect(html).toContain('打开当前路径')
    expect(html).toContain('打开上次路径')
    expect(html).not.toContain('删除')
  })

  test('Given 跨设备 ZIP 区块 When 渲染 Then 保留原创建和恢复流程', () => {
    const { CrossDeviceMigrationSection } = getExpectedModule()
    expect(typeof CrossDeviceMigrationSection).toBe('function')
    /** 静态 HTML 确认旧功能没有在路径管理改版中丢失。 */
    const html = renderToStaticMarkup(<CrossDeviceMigrationSection />)

    expect(html).toContain('当前设备：创建迁移压缩包')
    expect(html).toContain('复制创建压缩包提示词')
    expect(html).toContain('新设备：恢复 Proma 数据')
    expect(html).toContain('复制恢复数据提示词')
  })

  test('Given 已有 migration 导航状态 When 渲染设置导航 Then 保留 id 并显示路径与迁移', () => {
    /** 读取真实设置面板，锁定导航标签与组件接线。 */
    const settingsPanelSource = readFileSync(new URL('./SettingsPanel.tsx', import.meta.url), 'utf8')
    /** 读取真实 atom，锁定兼容的 tab id。 */
    const settingsTabSource = readFileSync(new URL('../../atoms/settings-tab.ts', import.meta.url), 'utf8')

    expect(settingsPanelSource).toContain('{ id: "migration", label: "路径与迁移"')
    expect(settingsPanelSource).toContain('return <PathManagementSettings />')
    expect(settingsTabSource).toContain("'migration'")
  })
})
