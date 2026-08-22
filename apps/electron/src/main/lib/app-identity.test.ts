import { describe, expect, test } from 'bun:test'
import { resolveAppIdentity } from './app-identity'

describe('Electron 应用身份', () => {
  test('Given 打包环境 When 解析身份 Then 使用正式版名称和 App ID', () => {
    expect(resolveAppIdentity(true)).toEqual({
      displayName: 'Proma',
      appId: 'com.bone.proma.app',
    })
  })

  test('Given 默认开发环境 When 解析身份 Then 使用独立开发身份', () => {
    expect(resolveAppIdentity(false)).toEqual({
      displayName: 'Proma Dev',
      appId: 'com.bone.proma.dev',
      safeStorageName: '@proma/electron',
      userDataDirectoryName: '@proma/electron-dev',
    })
  })

  test('Given 多工作树实例 When 解析身份 Then 名称和 userData 都包含清理后的实例名', () => {
    expect(resolveAppIdentity(false, ' feature/1 ')).toEqual({
      displayName: 'Proma Dev - feature1',
      appId: 'com.bone.proma.dev',
      safeStorageName: '@proma/electron',
      userDataDirectoryName: '@proma/electron-dev-feature1',
    })
  })
})
