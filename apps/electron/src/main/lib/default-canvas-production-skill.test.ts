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
  expect(skill).toMatch(/^version: "1\.0\.7"$/m)
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
    'canvas_update_image_config',
    'canvas_update_agent_config',
    'canvas_run_agent',
    'canvas_run_workflow',
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
  expect(skill).toContain('图片提示词、画幅、尺寸、模型或上下文')
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

test('Given 普通 Agent 需要专业分工 When 读取 canvas-production Then 可配置并运行单个 Canvas Agent 且不会推进下游', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toContain('使用 `canvas_update_agent_config`')
  expect(skill).toContain('已安装的专业 Skill')
  expect(skill).toContain('使用 `canvas_run_agent`')
  expect(skill).toContain('只运行一个 Canvas Agent')
  expect(skill).toContain('不会自动推进下游')
  expect(skill).toContain('Canvas Agent 不能递归运行其它 Agent 或工作流')
})

test('Given 用户明确要求执行整套画布方案 When 读取 canvas-production Then 仅运行指定根的可达图并停在图片采用边界', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toContain('优先使用 `canvas_run_workflow`')
  expect(skill).toContain('用户明确要求执行')
  expect(skill).toContain('仅运行指定起点可达的下游')
  expect(skill).toContain('不能仅因为存在连线就自动运行')
  expect(skill).toContain('文档和 WebView 不需要单独运行')
  expect(skill).toContain('不得超过 `maxImageRuns`')
  expect(skill).toContain('未获得采用授权时必须停在等待用户采用')
  expect(skill).toContain('从当前正式产物和待更新状态继续')
})

test('Given 使用第三方专业 Skill When 编排画布 Then Skill 只影响方法与质量且不能扩大 Host 权限', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toContain('第三方专业 Skill')
  expect(skill).toContain('只影响任务方法和输出质量')
  expect(skill).toContain('不能授予工具')
  expect(skill).toContain('不能修改项目代码')
  expect(skill).toContain('不能绕过审批')
  expect(skill).toContain('不能自动采用媒体候选')
})

test('Given 连续生产任务 When 读取 Skill Then 提供恢复与四类业务的实际交付步骤', () => {
  const skill = readCanvasProductionSkill()
  for (const capability of ['canvas_get_image_candidates', 'canvas_adopt_image_candidates',
    'canvas_resume_workflow', 'waiting-budget', 'retryNodeIds', 'media_import_local_file',
    'media_get_asset_file', 'canvas_attach_media_assets', '电影制作', '完整 App', '运营计划', '采集与数据分析', 'metadataOnly']) {
    expect(skill).toContain(capability)
  }
  expect(skill).toContain('提交结果未知')
  expect(skill).toContain('不能当作真实服务验收')
})
