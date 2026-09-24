import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ServerOpsConnectionDraftAgent } from '../server-ops/server-ops-connection-draft-agent'

/** 连接草稿只接受公开身份，不接收密码、私钥路径、会话或项目授权。 */
export function buildServerOpsConnectionTools(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  drafts: ServerOpsConnectionDraftAgent,
): ToolDefinition[] {
  return [sdk.defineTool({
    name: 'ops_connection_prepare', label: '准备运维连接草稿',
    description: 'Prepare a new SSH, MySQL, PostgreSQL, Redis or remote SQLite connection draft for this user session. The Server Ops panel lets the user choose the project, enter credentials, test and save. Never request passwords, private keys or passphrases in chat. This only creates an expiring in-memory draft; it does not save a connection, connect, test, read credentials, change database data or grant Agent access. Use hostId only from known server evidence; otherwise let the user choose the SSH server in the panel. MySQL chooses its database after connecting, so do not provide database. PostgreSQL may provide its connection database and only supports disabled, required or verify TLS. A successful result is pending user review, not a completed connection.',
    parameters: Type.Union([
      Type.Object({
        kind: Type.Literal('ssh'), name: Type.String({ minLength: 1, maxLength: 64 }),
        address: Type.String({ minLength: 1, maxLength: 255, description: 'Hostname or IP only; no URL or credentials.' }),
        port: Type.Integer({ minimum: 1, maximum: 65535 }), username: Type.String({ minLength: 1, maxLength: 128 }),
        authMethod: Type.Optional(Type.Union([Type.Literal('password'), Type.Literal('private-key'), Type.Literal('ssh-agent')])),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal('mysql'), label: Type.String({ minLength: 1, maxLength: 64 }),
        address: Type.String({ minLength: 1, maxLength: 255 }), port: Type.Integer({ minimum: 1, maximum: 65535 }),
        transport: Type.Union([Type.Literal('direct'), Type.Literal('ssh')]), hostId: Type.Optional(Type.String()),
        username: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        tlsMode: Type.Optional(Type.Union([Type.Literal('disabled'), Type.Literal('preferred'), Type.Literal('required'), Type.Literal('verify')])),
        tlsServerName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal('postgresql'), label: Type.String({ minLength: 1, maxLength: 64 }),
        address: Type.String({ minLength: 1, maxLength: 255 }), port: Type.Integer({ minimum: 1, maximum: 65535 }),
        transport: Type.Union([Type.Literal('direct'), Type.Literal('ssh')]), hostId: Type.Optional(Type.String()),
        username: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        database: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
        tlsMode: Type.Optional(Type.Union([Type.Literal('disabled'), Type.Literal('required'), Type.Literal('verify')])),
        tlsServerName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal('redis'), label: Type.String({ minLength: 1, maxLength: 64 }),
        address: Type.String({ minLength: 1, maxLength: 255 }), port: Type.Integer({ minimum: 1, maximum: 65535 }),
        transport: Type.Union([Type.Literal('direct'), Type.Literal('ssh')]), hostId: Type.Optional(Type.String()),
        username: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        tlsMode: Type.Optional(Type.Union([Type.Literal('disabled'), Type.Literal('required'), Type.Literal('verify')])),
        tlsServerName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
        database: Type.Optional(Type.String({ pattern: '^(?:[0-9]|1[0-5])$' })),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal('sqlite'), label: Type.String({ minLength: 1, maxLength: 64 }), transport: Type.Literal('ssh'),
        hostId: Type.Optional(Type.String()), filePath: Type.String({ minLength: 1, maxLength: 1024, description: 'Absolute SQLite file path on the chosen SSH server.' }),
      }, { additionalProperties: false }),
    ]),
    async execute(_id, params, signal) {
      /** 仅回传草稿状态；完整公开字段由所属会话在运维面板领取。 */
      const draft = drafts.prepare(params, signal)
      const result = { draftId: draft.id, kind: draft.input.kind, expiresAt: draft.expiresAt, status: 'pending-review',
        nextStep: '已生成连接草稿，请在当前会话的运维面板选择项目并审阅，填写凭据后测试、保存。尚未保存或建立连接。' }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], details: result }
    },
  })] as ToolDefinition[]
}
