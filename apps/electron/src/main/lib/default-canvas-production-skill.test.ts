import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const canvasProductionSkillPath = join(
  import.meta.dir,
  '../../../default-skills/canvas-production/SKILL.md',
)

/** 读取随应用分发的 Canvas 生产 Skill；缺失时返回空文本以保留清晰断言。 */
function readCanvasProductionSkill(): string {
  return existsSync(canvasProductionSkillPath)
    ? readFileSync(canvasProductionSkillPath, 'utf-8')
    : ''
}

test('Given canvas-production 默认 Skill When 校验发布合同 Then 元数据包含 Proma 分组与明确触发边界', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toMatch(/^name: canvas-production$/m)
  expect(skill).toMatch(/^group: proma$/m)
  expect(skill).toMatch(/^version: "1\.0\.1"$/m)
  expect(skill).toContain('产品套图')
  expect(skill).toContain('漫剧分镜')
  expect(skill).toContain('交互视觉稿')
  expect(skill).toContain('普通代码')
  expect(skill).toContain('不要强行转入画布')
})

test('Given 多产物画布任务 When 读取 canvas-production Then 定义节点拆分、关系语义与完整工具循环', () => {
  const skill = readCanvasProductionSkill()

  for (const toolName of [
    'canvas_get_context',
    'canvas_manage',
    'canvas_read',
    'canvas_apply_changes',
    'canvas_create_artifact',
    'canvas_update_artifact',
    'canvas_run_nodes',
  ]) {
    expect(skill).toContain(toolName)
  }
  expect(skill).toContain('一个可独立评审、复用或迭代的产物对应一个节点')
  expect(skill).toContain('association')
  expect(skill).toContain('reference')
  expect(skill).toContain('depends-on')
  expect(skill).toContain('derives')
  expect(skill).toContain('局部更新')
  expect(skill).toContain('普通创建不要主动提供 `position`')
  expect(skill).toContain('由 Proma 根据来源关系和真实节点尺寸紧凑排布')
})

test('Given Canvas Skill 负责语义编排 When 校验执行边界 Then 权限、破坏性操作和付费运行仍由工具层控制', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toContain('Skill 不授予任何画布权限')
  expect(skill).toContain('destructiveIntent=explicit')
  expect(skill).toContain('WebView 创建后即可预览')
  expect(skill).toContain('不要为 WebView 调用 `canvas_run_nodes`')
  expect(skill).toContain('用户明确要求立即生成图片')
  expect(skill).toContain('单次审批')
  expect(skill).toContain('候选已生成')
  expect(skill).toContain('不得描述为已经正式替换')
})
