import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 读取随应用分发的 session-cleaner Skill 正文。 */
function readSessionCleanerSkill(): string {
  return readFileSync(
    join(import.meta.dir, '../../../default-skills/session-cleaner/SKILL.md'),
    'utf-8',
  )
}

test('Given session-cleaner 默认 Skill When 校验发布合同 Then 版本与 CLI 优先规则保持同步', () => {
  /** 默认 Skill 文本同时承担版本升级和 Agent 命令入口合同。 */
  const skill = readSessionCleanerSkill()
  const unconditionalPlainCommands = skill
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('proma session ') && line !== 'proma session "$@"')

  expect(skill).toMatch(/^version: 2\.0\.1$/m)
  expect(skill).toContain('"$PROMA_CLI" session "$@"')
  expect(skill).toContain('仅当 `PROMA_CLI` 缺失时')
  expect(skill).not.toContain('优先直接 `proma session')
  expect(unconditionalPlainCommands).toEqual([])
})

test('Given session-cleaner CLI 参考 When 校验数据根说明 Then 不再宣称开发模式默认使用 proma-dev', () => {
  /** reference 必须与 Electron 和 CLI 当前共享活动数据根的实现一致。 */
  const reference = readFileSync(
    join(import.meta.dir, '../../../default-skills/session-cleaner/references/cli-usage.md'),
    'utf-8',
  )

  expect(reference).toContain('PROMA_CONFIG_DIR')
  expect(reference).toContain('.proma-location.json')
  expect(reference).not.toContain('开发模式（`PROMA_DEV=1` 或 Proma 未打包）数据在 `~/.proma-dev/`')
})
