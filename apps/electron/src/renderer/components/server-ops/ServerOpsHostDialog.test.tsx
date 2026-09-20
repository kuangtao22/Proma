import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsAuthMethod } from '@proma/shared'
import { ServerOpsCredentialFields } from './ServerOpsHostDialog'
import { buildServerOpsHostTestInput } from './ServerOpsHostDialog'
import { describeServerOpsHostTestFailure } from './ServerOpsHostDialog'

/** 渲染指定认证方式和编辑状态下的凭据字段。 */
function renderCredentialFields(
  authMethod: ServerOpsAuthMethod,
  credentialAction: 'keep' | 'replace' | 'clear',
  hasSavedCredential = false,
): string {
  return renderToStaticMarkup(
    <ServerOpsCredentialFields
      authMethod={authMethod}
      credentialAction={credentialAction}
      hasSavedCredential={hasSavedCredential}
      password=""
      keyPath="~/.ssh/id_ed25519"
      passphrase=""
      showPassword={false}
      onCredentialActionChange={() => undefined}
      onPasswordChange={() => undefined}
      onKeyPathChange={() => undefined}
      onPassphraseChange={() => undefined}
      onShowPasswordChange={() => undefined}
    />,
  )
}

describe('服务器配置凭据字段', () => {
  test('连接测试调用失败时给出可操作提示，而不是无法诊断的兜底文案', () => {
    /** 旧客户端没有注入测试方法时浏览器抛出的真实错误。 */
    const missingMethod = new TypeError('window.electronAPI.testServerOpsConnection is not a function')
    expect(describeServerOpsHostTestFailure(missingMethod)).toBe('当前客户端不支持连接测试，请重启客户端后再试')
    expect(describeServerOpsHostTestFailure(new Error('Error invoking remote method: SERVER_OPS_ACCESS_DENIED')))
      .toBe('当前窗口没有服务器运维权限')
    expect(describeServerOpsHostTestFailure(new Error('SERVER_OPS_TEST_CONNECTION_INPUT_INVALID')))
      .toBe('连接参数不合法，请检查地址、端口与用户名')
    expect(describeServerOpsHostTestFailure(new Error('boom'))).toBe('连接测试调用失败，请查看主进程日志')
  })

  test('连接测试只使用当前草稿：保留已保存凭据时复用密文，其余情况必须有本次凭据', () => {
    /** 编辑已有密码主机且选择保留凭据。 */
    expect(buildServerOpsHostTestInput({
      address: '10.0.0.8', port: '22', username: 'deploy', authMethod: 'password',
      credentialAction: 'keep', hostId: 'host-1', password: '', keyPath: '', passphrase: '',
    })).toEqual({ address: '10.0.0.8', port: 22, username: 'deploy', hostId: 'host-1' })

    /** 新建密码主机但没有填写密码：不构造输入，避免发起匿名连接。 */
    expect(buildServerOpsHostTestInput({
      address: '10.0.0.8', port: '22', username: 'deploy', authMethod: 'password',
      credentialAction: 'replace', password: '', keyPath: '', passphrase: '',
    })).toBeNull()

    /** 本次填写的密码与私钥口令都按原样进入请求，且绝不请求持久化。 */
    expect(buildServerOpsHostTestInput({
      address: '10.0.0.8', port: '22', username: 'deploy', authMethod: 'password',
      credentialAction: 'replace', password: 'p@ss', keyPath: '', passphrase: '',
    })).toEqual({ address: '10.0.0.8', port: 22, username: 'deploy', credential: { kind: 'password', password: 'p@ss', remember: false } })
    expect(buildServerOpsHostTestInput({
      address: '10.0.0.8', port: '22', username: 'deploy', authMethod: 'private-key',
      credentialAction: 'replace', password: '', keyPath: ' ~/.ssh/id_rsa ', passphrase: 'secret',
    })).toEqual({
      address: '10.0.0.8', port: 22, username: 'deploy',
      credential: { kind: 'private-key', keyPath: '~/.ssh/id_rsa', passphrase: 'secret', remember: false },
    })
    /** SSH Agent 不需要任何本次凭据。 */
    expect(buildServerOpsHostTestInput({
      address: '10.0.0.8', port: '22', username: 'deploy', authMethod: 'ssh-agent',
      credentialAction: 'clear', password: '', keyPath: '', passphrase: '',
    })).toEqual({ address: '10.0.0.8', port: 22, username: 'deploy', credential: { kind: 'ssh-agent' } })
  })

  test('密码和私钥认证在服务器配置内展示对应凭据输入', () => {
    /** 密码认证的字段 HTML。 */
    const passwordHtml = renderCredentialFields('password', 'replace')
    /** 私钥认证的字段 HTML。 */
    const privateKeyHtml = renderCredentialFields('private-key', 'replace')

    expect(passwordHtml).toContain('SSH 密码')
    expect(passwordHtml).toContain('type="password"')
    expect(privateKeyHtml).toContain('私钥文件')
    expect(privateKeyHtml).toContain('私钥口令')
  })

  test('已有凭据只展示安全状态和变更入口，不回填秘密', () => {
    /** 已保存密码凭据的状态 HTML。 */
    const html = renderCredentialFields('password', 'keep', true)

    expect(html).toContain('凭据已保存')
    expect(html).toContain('替换凭据')
    expect(html).toContain('清除凭据')
    expect(html).not.toContain('SSH 密码')
    expect(html).not.toContain('password-canary')
  })

  test('SSH Agent 只展示系统代理说明且不渲染秘密输入', () => {
    /** SSH Agent 的说明 HTML。 */
    const html = renderCredentialFields('ssh-agent', 'clear')

    expect(html).toContain('系统 SSH Agent')
    expect(html).not.toContain('SSH 密码')
    expect(html).not.toContain('私钥口令')
  })
})
