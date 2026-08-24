# 设计工作区生图模型选择设计

## 目标

设计工作区采用明确的双模型链路：Proma 现有 Agent LLM 先理解用户的生成或编辑要求，再由 Design Job 强制调用用户在当前设计项目中选择的生图模型。用户选择必须在主进程执行边界生效，不能只依赖提示词或 Agent 自觉传参。

这项改动解决三个问题：

- 用户能在设计界面看见并切换当前生图模型；
- Agent LLM 与生图模型职责分离，普通对话模型不会被误当成图片输出模型；
- 任务、重试和历史记录能准确说明实际使用了哪个生图模型。

## 产品边界

- 设计页只选择生图模型，不新增第二个 Agent LLM 选择器。
- Agent LLM 继续沿用现有规则：来源会话模型优先，Proma 全局 Agent 渠道和模型兜底。
- 生图选择器只展示系统生图模型目录中已启用、凭据完整且当前执行器支持的模型。
- 首版生图执行器继续复用 Nano Banana/Gemini Image Generation，不把任意 Chat 渠道模型自动视为生图模型。
- 首版不实现 OpenAI Images、火山图片等新的供应商协议；后续通过同一模型目录和执行器接口扩展。
- 新任务固化提交时的生图模型；任务重试继续使用原任务模型。切换模型后重新提交，才创建使用新模型的任务。

## 用户界面

`AI 编辑` 标签顶部增加固定的“生图模型”字段，位于生成/编辑表单之前，因此空画布生成与单素材编辑共享同一选择。

```text
AI 编辑
┌──────────────────────────────┐
│ 生图模型                     │
│ [ Nano Banana Flash      ▾ ] │
├──────────────────────────────┤
│ 描述 / 编辑要求              │
│ 画面比例 / 图片尺寸 / 蒙版   │
│ [ 生成图片 / 开始编辑 ]      │
└──────────────────────────────┘
```

- 选择项显示配置名称和真实模型 ID，避免多个配置同名时无法判断。
- 每个项目记住最近一次有效选择；切换项目时立即恢复对应选择。
- 只有一个可用模型时仍显示选择器，让用户明确知道当前实际出图模型。
- 没有可用模型时，选择器显示“未配置生图模型”，生成和编辑按钮保持禁用，并提供进入系统生图设置的明确入口。
- 当前选择被删除、停用或凭据失效时，不静默切换到其他模型；界面要求用户重新选择。
- 加载模型目录时保留稳定尺寸骨架，避免右栏表单跳动；键盘、Tooltip、明暗主题沿用现有 Radix/shadcn 和主题变量。

## 系统生图模型目录

新增主进程生图模型目录，作为设计页和图片执行器共同使用的唯一事实来源。目录只保存非敏感配置：

```ts
interface ImageGenerationModelProfile {
  id: string
  name: string
  executor: 'nano-banana'
  modelId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}
```

配置持久化在 `~/.proma/image-generation-models.json`，通过 `safe-file.ts` 原子写入。API Key 和 Base URL 继续由现有 Nano Banana 工具凭据管理，模型目录只引用执行器，不复制凭据或把密钥发给 Renderer。

兼容现有安装：

- 配置文件不存在时，根据 Nano Banana 现有 `credentials.model` 或默认模型合成一个只读默认项；
- 用户第一次修改生图模型目录时才写入新文件；
- 旧 Chat 和普通 Agent 的 Nano Banana 调用继续使用原全局模型，不因 Design 项目选择而改变；
- 系统设置中的 Nano Banana 区域从单一模型文本框升级为模型配置列表，同一套 API Key/Base URL 可配置多个模型 ID 和显示名称。

目录对 Renderer 只返回经过清洗的选项：稳定 ID、显示名称、模型 ID、可用状态和不可用原因。凭据、真实配置文件路径和解密结果永不进入 IPC 响应。

## 项目偏好

生图模型选择属于本机运行环境，不写入随项目迁移的 `canvas.json`。原因是模型 ID 和凭据只在当前 Proma 安装中有意义，把它写入项目正式数据会制造不可移植依赖。

每个项目的选择保存在：

```text
~/.proma/design-cache/<project-id>/preferences.json
```

```ts
interface DesignProjectPreferences {
  schemaVersion: 1
  imageModelProfileId?: string
  updatedAt: number
}
```

- 文件通过 `safe-file.ts` 原子写入；项目迁移不复制该文件。
- Renderer 的 Jotai 状态缓存当前项目选项和选择，但主进程文件是跨窗口、重启和开发/正式客户端共享的事实。
- 多窗口同时更新时采用最后一次完整选择写入，并广播项目偏好变化；不存在画布 revision 合并问题。
- 偏好指向不可用配置时保留原 ID 作为诊断信息，但 UI 必须进入未选择状态，禁止自动回退。

## 共享契约与 IPC

四层 IPC 同步新增以下受控能力：

- 获取项目的可用生图模型、当前选择和不可用原因；
- 更新项目选择，并由主进程验证模型配置仍可用；
- 广播同项目生图偏好变化；
- 创建 Design Job 时提交当前 `imageModelProfileId`。

`CreateDesignJobInput` 和 `DesignJobRecord` 增加生图模型快照。公开任务记录必须包含稳定配置 ID、执行器、模型 ID 和创建时显示名称，避免配置改名后历史任务失真。

Renderer 只能提交稳定配置 ID。主进程在创建任务的工作区写守卫内重新解析目录并固化完整快照，拒绝未知、停用、缺少凭据或执行器不支持的配置。Renderer 传入的模型名称、执行器或 Base URL 均不构成授权事实。

## 双阶段执行链路

```text
设计页选择生图模型
  -> 创建 Design Job，主进程固化模型快照
  -> 现有规则解析 Agent LLM 渠道和模型
  -> Pi Agent 理解任务并调用一次图片工具
  -> 运行级扩展把固化的生图路由注入图片工具
  -> 图片工具使用指定 modelId 调用 Gemini Image Generation
  -> 现有附件归属校验、素材导入和画布替换流程继续执行
```

关键约束：

- 生图模型不作为 Agent 可自由修改的工具参数暴露。
- Design Job 通过仅主进程内部可见的 `AgentRunExtensions` 传入生图路由。
- `buildPiBuiltinTools` 将该路由交给 Nano Banana 工具上下文；工具执行时优先使用受信任路由，而不是全局默认模型。
- 受信任路由只对本轮 Design Job 有效，不修改 `chat-tools.json`，也不影响其他并发 Agent 会话。
- Agent 提示词仍要求只调用一次图片工具，并继续携带画面比例、尺寸、参考图和蒙版信息；提示词中不承担模型授权职责。
- 工具执行前再次核对配置和凭据。若任务排队后配置被删除或停用，任务明确失败，不改用其他模型。

## 任务记录与重试

- queued journal 在占位节点提交前写入完整生图模型快照，保持现有两阶段恢复语义。
- running、succeeded、failed、cancelled 和 interrupted 状态均保留同一快照。
- retry replacement 复制原任务模型快照，不重新读取当前项目偏好，保证重试语义稳定且可复现。
- 历史模型配置被删除不影响任务 journal 读取；只有重新执行时才因配置不可用而失败。
- 任务节点和错误信息显示实际模型名称或模型 ID，方便用户判断成本、速度和失败来源。

## 错误处理

- 模型目录加载失败：保留表单输入，禁用提交并提供重试，不清空项目偏好。
- 无可用生图模型：显示配置入口，不创建任务或占位节点。
- 偏好写入失败：选择器恢复到主进程返回的旧选择并提示失败。
- 创建任务时模型已变化：主进程拒绝并要求刷新选项，不采用 Renderer 陈旧信息。
- Agent LLM 失败：沿用现有 Design Job 失败状态，不调用生图模型。
- 生图模型调用失败：保留失败占位和具体执行器错误摘要，不导入半成品。
- 模型返回文本但没有有效图片：沿用“任务完成但没有产生可验证图片”边界。

## 关联模块与兼容性

- 普通 Chat 和 Agent 的模型选择、会话元数据、自动任务与 LAN Bridge 不变。
- 普通 Nano Banana 调用继续读取全局默认模型；只有 Design Job 注入运行级覆盖。
- Design Job journal schema 增加字段后必须保留旧 journal 兼容：旧任务读取时解析为“未记录模型”，只能展示历史状态，禁止自动重跑；用户重新提交后生成新格式任务。
- IPC 改动必须同步 shared、main、preload 和 renderer adapter。
- 项目迁移守卫、稳定附件归属、媒体 lease、SAVE/recovery 代际和退出隔离保持现有实现，不因模型选择重新打开已收紧的边界。

## 性能与资源影响

- 模型目录和项目偏好是小型 JSON，首次进入设计页或配置变化时加载；不随画布帧、拖动或保存循环读取。
- Renderer 按项目缓存选项，配置广播后再刷新；不会增加 XYFlow 节点渲染或大画布内存开销。
- 每个任务仍然是一轮 Agent LLM 加一次生图工具调用，没有新增隐藏模型轮次。
- 多个生图配置共享现有执行器和凭据，不新增常驻进程、端口或运行时依赖。

## 测试与验收

所有新增行为使用 BDD 风格测试，并按 TDD 顺序先观察失败。

### 共享契约与配置

- Given 旧 Nano Banana 单模型配置，When 首次读取目录，Then 合成可用默认项且不立即写文件；
- Given 多个生图配置，When 列出选项，Then 只返回启用且凭据完整的清洗字段；
- Given 损坏或未知版本配置，When 读取，Then 明确失败且不覆盖原文件；
- Given 项目 A 和 B，When 分别选择模型，Then 偏好互不串线且重启可恢复。

### Design Job

- Given 当前项目选择模型 B，When 创建任务，Then journal 固化模型 B 的完整快照；
- Given Agent LLM 完成并调用工具，When 执行生图，Then 请求使用模型 B 而非全局默认模型；
- Given Agent 尝试传入其他模型，When 工具执行，Then 仍使用受信任的任务模型；
- Given 模型在排队后停用，When 运行任务，Then 明确失败且不回退；
- Given 失败任务使用模型 B，When 重试，Then replacement 继续使用模型 B；
- Given 旧 journal 不含模型快照，When 恢复，Then 可展示但不能自动付费重跑。

### Renderer 与 IPC

- Given 多个可用生图模型，When 打开 AI 编辑，Then 显示当前项目选择并支持键盘切换；
- Given 只有一个模型，When 打开 AI 编辑，Then 仍显示实际模型；
- Given 无模型或当前模型不可用，When 渲染，Then 生成和编辑均禁用并显示配置入口；
- Given Renderer 伪造模型 ID，When 创建任务，Then 主进程在任何 Agent 或 Store 副作用前拒绝；
- Given 两个窗口修改同一项目偏好，When 广播到达，Then 两边最终显示主进程最新选择。

### 回归验证

- Design 全量测试；
- Agent 工具白名单、Nano Banana 附件来源和 Design 输出归属测试；
- 全仓 `bun run typecheck`；
- `bun run electron:build`；
- 真实 Electron 窗口检查模型选择、无配置状态、生成/编辑提交、窄窗口和明暗主题。

## 验收标准

- 用户能在每个项目的设计页明确选择系统配置的生图模型；
- Design Job 始终先调用 Agent LLM，再由图片工具使用固化的当前选择出图；
- 模型选择在主进程执行层强制生效，不能被 Agent 提示词或工具参数绕过；
- 切换项目、重启、多窗口和任务重试均保持定义好的选择语义；
- 普通 Agent、Chat 和 Nano Banana 会话不受 Design 项目选择影响；
- 没有可用模型或配置变化时明确阻断，不产生错误计费或静默回退。
