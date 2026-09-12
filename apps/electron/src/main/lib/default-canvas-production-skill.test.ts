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

test('Given 导演首次接管或局部复核 When 读取规范 Then 显式审核范围与位置及生成依赖分别定义', () => {
  /** 默认入口和详细合同均须说明新增工具字段，避免只有代码支持而模型不会调用。 */
  const skill = readCanvasProductionSkill()
  const review = readFileSync(join(canvasProductionSkillPath, '../references/production-review.md'), 'utf8')
  for (const rule of ['reviewScope', 'positionBeforeNodeIds', 'reviewCoverage', '孤立节点', '逐节点', '局部复核']) {
    expect(skill).toContain(rule)
    expect(review).toContain(rule)
  }
  expect(review).toContain('scopeRevision')
  expect(review).toContain('配置版本可能独立于图版本变化')
  expect(review).toContain('先完成读取，再写方案')
  expect(review).toContain('不为审核添加执行依赖')
})

test('Given canvas-production 默认 Skill When 校验发布合同 Then 元数据包含 Proma 分组与明确触发边界', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toMatch(/^name: canvas-production$/m)
  expect(skill).toMatch(/^group: proma$/m)
  expect(skill).toMatch(/^version: "1\.0\.27"$/m)
  expect(skill).toContain('产品套图')
  expect(skill).toContain('漫剧分镜')
  expect(skill).toContain('交互视觉稿')
  expect(skill).toContain('普通代码')
  expect(skill).toContain('不要强行转入画布')
})

test('Given 按用途编排与视频评审 When 读取默认 Skill Then 运行前入口可达且详细合同随 Skill 分发', () => {
  /** 主入口与按需参考必须一起发布，避免仅新增一个 Agent 永远不会读取的文件。 */
  const skill = readCanvasProductionSkill()
  const reviewPath = join(canvasProductionSkillPath, '../references/production-review.md')
  expect(skill).toContain('references/production-review.md')
  expect(skill).toContain('只评审时不创建或运行导演；已有当前有效方案时直接读取评审，不重跑导演')
  expect(skill).toContain('创建或运行导演还必须符合本轮工具能力；permissionCeiling=plan 时只读取现有方案并给出规划建议')
  expect(skill.indexOf('### 2.3 按用途选择模式并评审')).toBeGreaterThan(0)
  expect(skill.indexOf('### 2.3 按用途选择模式并评审')).toBeLessThan(skill.indexOf('### 3. 规划产物图'))
  expect(existsSync(reviewPath)).toBe(true)
  /** 文档合同验证可达性与关键边界，不声称静态测试已经验证模型的导演能力。 */
  const review = readFileSync(reviewPath, 'utf-8')
  for (const rule of ['制作模式', '生成模式', '阻塞问题', '改进建议', '实际末帧',
    'canvas_run_agent', 'canvas_task', 'metadataOnly', '只读', '主 Agent', '版本']) {
    expect(review).toContain(rule)
  }
  expect(review).toContain('只评审时不创建或运行导演；已有当前有效方案时直接读取评审，不重跑导演')
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
    'canvas_get_task',
    'canvas_cancel_task',
    'canvas_retry_task',
    'canvas_list_versions',
    'canvas_read_version',
    'canvas_adopt_version',
    'canvas_adopt_candidate_batch',
    'canvas_export_artifact',
    'canvas_list_trash',
    'canvas_restore_node',
    'canvas_rebuild_agent',
    'canvas_list_workflows',
    'canvas_get_workflow',
    'canvas_resume_workflow',
    'canvas_cancel_workflow',
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
  expect(skill).toContain('`mode=all`')
  expect(skill).toContain('`mode=succeeded`')
  expect(skill).toContain('不得把部分节点列表伪装成原子批次采用')
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

test('Given 用户授权审核并修复 When 读取 Skill Then 定义有界修复循环且读取故障不能导致重建', () => {
  const skill = readCanvasProductionSkill()
  for (const rule of ['审核并修复', '本任务授权', '最多两轮', '读取失败不等于内容错误',
    'readError', 'missingNodeIds', 'omittedEdgeCount', '先验证新节点', '全部入边和出边',
    '原工作流预算', '未复核', '不能通过新建运行重置预算']) {
    expect(skill).toContain(rule)
  }
  expect(skill).not.toContain('该工具仍需要单次审批')
})

test('Given 图片异步生成或重试已提交 When 读取 Skill Then 继续等待终态并按已有授权复核', () => {
  const skill = readCanvasProductionSkill()
  for (const rule of ['replacementJobId', 'waitMs=30000', '已提交不等于完成',
    '超时仍为 running', '原任务', 'No available compatible accounts', '实际错误', '已有采用授权']) {
    expect(skill).toContain(rule)
  }
})

test('Given 图片迭代与成对帧生产 When 读取 Skill Then 锁定真实图源、请求证据、重试边界与母版验收', () => {
  const skill = readCanvasProductionSkill()

  for (const rule of [
    'editSourceNodeId',
    '`image.asset` → `image.reference`',
    '`null` 表示采用当前图片',
    '“母版”不代表已经切换底图',
    '原快照重试',
    '“图片请求已准备”',
    'assetId',
    'hash',
    '数量',
    '它不代表远端服务已经收到',
    '无 `mask` 的编辑不能保证局部锁定',
    '适配',
    '道具',
    '机位',
    '构图',
    '手位',
    '母版不合格时先不扩散',
  ]) {
    expect(skill).toContain(rule)
  }
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

  expect(skill).toContain('`canvas_update_agent_config`')
  expect(skill).toContain('`artifact.configRevision`')
  expect(skill).toContain('`expectedGraphRevision` 使用读取结果的顶层 `revision`')
  expect(skill).toContain('`configOmitted`')
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

test('Given 四类 Agent 运行范围 When 读取 canvas-production Then 十五个操作与权限发现保持一致', () => {
  const skill = readCanvasProductionSkill()

  expect(skill).toContain('普通 Agent 可使用当前已装配的全部任务')
  expect(skill).toContain('交互式 Canvas Agent 固定在当前画布内工作')
  expect(skill).toContain('没有 schema 的动作不能由 Skill 自行补充')
  expect(skill).toContain('父编排的 Canvas Agent 负责分支内容与配置准备')
  expect(skill).toContain('媒体启动、预算与父工作流控制继续由父层负责')
  expect(skill).toContain('`plan` 模式的画布查询与内存任务登记可直接执行')
  expect(skill).toContain('CANVAS_OPERATION_CURSOR_INVALID')
  expect(skill).toContain('等待采用、可继续、完成和取消状态')
  expect(skill).toContain('批量导出最多十六项')
  expect(skill).toContain('相同工具调用重放必须复用原结果')
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
