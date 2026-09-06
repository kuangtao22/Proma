import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsAuthMethod } from '@proma/shared'
import { ServerOpsCredentialFields } from './ServerOpsHostDialog'

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
