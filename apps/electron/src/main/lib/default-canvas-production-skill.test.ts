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
  expect(skill).toMatch(/^version: "1\.0\.4"$/m)
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
    'canvas_list_nodes',
    'canvas_inspect_images',
    'canvas_read',
    'canvas_apply_changes',
    'canvas_create_agent',
    'canvas_import_image',
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
  expect(skill).toContain('先建立并验证新链路')
  expect(skill).toContain('再删除旧节点')
})

test('Given 用户只要求核对全部图片 When 读取 canvas-production Then 先枚举再看当前采用缩略图且保持只读', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toContain('核对只读')
  expect(skill).toContain('先使用 `canvas_list_nodes`')
  expect(skill).toContain('再使用 `canvas_inspect_images`')
  expect(skill).toContain('不得只比较提示词')
  expect(skill).toContain('不得使用画布截图')
  expect(skill).toContain('不更新提示词')
  expect(skill).toContain('不调用 `canvas_run_nodes`')
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

test('Given 当前会话位于 Canvas Agent 节点 When 执行生产任务 Then 读取直接输入并由自身创建下游产物', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toContain('当前会话位于 Canvas Agent 节点')
  expect(skill).toContain('直接输入节点')
  expect(skill).toContain('由当前 Canvas Agent 直接创建或更新下游产物')
  expect(skill).toContain('不得把普通 Agent、协作会话或当前会话伪装绑定为 Canvas Agent 节点')
  expect(skill).toContain('不得要求用户在主会话与 Canvas Agent 之间反复复制任务')
  expect(skill).toContain('普通 Agent 自行调用 `canvas_create_agent`')
})

test('Given Agent 已有授权本地参考图 When 读取 canvas-production Then 使用导入工具并立即设为正式采用版本', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toContain('使用 `canvas_import_image`')
  expect(skill).toContain('立即成为该图片节点的正式采用版本')
  expect(skill).toContain('不得要求用户拖入或上传到原生 Canvas')
})
