import { describe, expect, test } from 'bun:test'
import { utils } from 'ssh2'
import { createServerOpsSshFixtureHostKey } from './server-ops-sftp-fixture'

describe('Server Ops SSH/SFTP fixture Host Key', () => {
  test('Given fixture repeatedly creates host keys When ssh2 parses them Then every key remains valid', () => {
    for (let index = 0; index < 512; index += 1) {
      /** 每轮都生成独立测试密钥，覆盖发布全量测试中的重复 fixture 启动。 */
      const hostKey = createServerOpsSshFixtureHostKey()
      const parsed = utils.parseKey(hostKey)
      expect(parsed).not.toBeInstanceOf(Error)
      if (parsed instanceof Error) throw parsed
      expect(parsed.type).toBe('ecdsa-sha2-nistp256')
    }
  })
})
