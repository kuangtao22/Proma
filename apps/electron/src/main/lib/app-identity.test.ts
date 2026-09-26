import { describe, expect, test } from 'bun:test'
import { resolveAppIdentity } from './app-identity'

describe('Electron 应用身份', () => {
  test('Given 打包环境 When 解析身份 Then 使用 DutyDeck 展示名与稳定 App ID', () => {
    expect(resolveAppIdentity(true)).toEqual({
      displayName: 'DutyDeck',
      appId: 'com.bone.proma.app',
      safeStorageName: '@proma/electron',
    })
  })

  test('Given 默认开发环境 When 解析身份 Then 使用独立开发身份', () => {
    expect(resolveAppIdentity(false)).toEqual({
      displayName: 'DutyDeck Dev',
      appId: 'com.bone.proma.dev',
      safeStorageName: '@proma/electron',
      userDataDirectoryName: '@proma/electron-dev',
    })
  })

  test('Given 多工作树实例 When 解析身份 Then 名称和 userData 都包含清理后的实例名', () => {
    expect(resolveAppIdentity(false, ' feature/1 ')).toEqual({
      displayName: 'DutyDeck Dev - feature1',
      appId: 'com.bone.proma.dev',
      safeStorageName: '@proma/electron',
      userDataDirectoryName: '@proma/electron-dev-feature1',
    })
  })

  test('Given 品牌改名 When 解析任何环境的身份 Then 加密身份与 App ID 都不跟随展示名变化', () => {
    /** 打包版与开发版的展示名已改为 DutyDeck，但加密身份必须仍是历史值。 */
    const packaged = resolveAppIdentity(true)
    const development = resolveAppIdentity(false)

    expect(packaged.safeStorageName).toBe('@proma/electron')
    expect(development.safeStorageName).toBe('@proma/electron')
    expect(packaged.appId).toBe('com.bone.proma.app')
    expect(development.appId).toBe('com.bone.proma.dev')
    expect(packaged.displayName).not.toContain('@proma')
    expect(development.displayName).not.toContain('@proma')
  })
})
