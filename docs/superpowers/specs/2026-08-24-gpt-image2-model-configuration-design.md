# GPT Image 2 统一模型配置设计

## 结论

GPT Image 2 应作为 Design 可选择的生图执行器接入，但用户配置入口统一放在现有“模型配置”页面。底层继续保留 fork 自有的生图模型目录、执行器和 Design 可信路由，不给官方高频变动的 `ChannelModel`、`ChannelForm` 或渠道持久化结构增加图片能力字段。

这一边界同时满足两个目标：

- 用户只需在“模型配置”管理 Base URL、API Key、真实模型和生图用途，不再到“Chat 工具”寻找 Design 配置；
- 后续合入官方代码时，主要冲突面限制在 `ChannelSettings` 的一个稳定挂载点，图片协议和路由逻辑留在 fork 自有文件。

## 目标

- 支持在 Proma 模型配置中接入 `gpt-image-2`，供 Design 文生图和参考图编辑使用；
- Design 对话仍先调用当前 Agent LLM 理解任务，再由图片工具调用项目当前选择的生图模型；
- GPT Image 2 复用现有渠道的 Base URL、加密 API Key 和模型列表，不建立第二套敏感凭据；
- Nano Banana 保持兼容，现有项目选择、任务快照、重试和历史记录不失效；
- 生图协议由主进程可信路由决定，Agent 和 Renderer 不能通过参数替换执行器、渠道或模型；
- 尽量减少对官方渠道配置主链的修改，降低长期同步成本。

## 非目标

- 不改变普通 Chat、Agent、Automation 或 LAN Bridge 的模型选择语义；
- 不给所有渠道模型自动推断“支持生图”，也不扩展 `ChannelModel` 能力字段；
- 不把 GPT Image 2 注册成普通 Chat 工具开关；
- 不迁移或删除用户现有 Nano Banana 凭据；
- 不在首版实现图片变体、局部蒙版绘制、流式图片响应或供应商私有高级参数；
- 不把外部 Python 脚本或 Python 运行时带入 Proma，主进程直接使用 HTTP 协议。

## 产品入口

“模型配置”页面保留现有渠道配置列表，并在其下增加一个独立的“生图模型”区块。该区块复用当前 `ImageGenerationModelSettings` 的列表编辑能力，但数据来源改为“现有模型配置 + 生图执行路由”。

```text
模型配置

模型服务
┌──────────────────────────────────────────────┐
│ GPT Image 服务  OpenAI  已启用       编辑   │
│ http://100.124.186.117:8030/v1              │
│ gpt-image-2                                  │
└──────────────────────────────────────────────┘

生图模型
┌──────────────────────────────────────────────┐
│ GPT Image 2                                  │
│ 模型配置 [ GPT Image 服务              ▾ ]   │
│ 模型       [ gpt-image-2                ▾ ]   │
│ 调用协议   [ OpenAI Images              ▾ ]   │
│ 已启用 [✓]                         删除      │
└──────────────────────────────────────────────┘
                                      [保存配置]
```

用户流程：

1. 在现有模型配置中新增 OpenAI 或 Custom 渠道，填写 Base URL、API Key，并添加 `gpt-image-2` 模型；
2. 在同页“生图模型”区块新增一条路由，选择上述渠道、模型和 `OpenAI Images` 协议；
3. 在 Design 页的生图模型选择器中选中该配置；
4. 提交对话后，Agent LLM 先理解要求，图片工具再按任务固化的 GPT Image 2 路由执行。

明确采用两步配置而不根据模型 ID 自动识别能力。模型名只是供应商自定义字符串，自动识别会产生误判，也无法可靠决定应使用 Chat Completions、Responses、Gemini GenerateContent 或 OpenAI Images 协议。

“Chat 工具”页面移除 Design 生图模型目录，只保留 Nano Banana 作为普通 Chat/Agent 工具时的启用开关和旧凭据管理。Design 页的“前往配置”入口改为打开“模型配置”并聚焦“生图模型”区块。

## 低冲突边界

### 保持不变的官方主链

- `ChannelModel` 继续只有 `id`、`name`、`enabled`、`source`；
- `Channel`、`ChannelCreateInput`、`ChannelUpdateInput` 和渠道 JSON schema 不增加生图字段；
- `ChannelForm` 继续只负责供应商连接、API Key 和模型列表；
- `channel-manager` 继续作为渠道与加密凭据事实来源，不承担生图能力判断；
- 普通 Agent 解析渠道、模型和凭据的路径不变。

### fork 自有边界

- 生图 profile schema、校验和迁移位于 `image-generation-model-catalog`；
- OpenAI Images 请求、响应解析和附件保存位于新的图片执行器模块；
- 按 executor 分派可信路由位于图片工具构建层；
- Design Job 继续只携带固化的 `ImageGenerationModelSnapshot`；
- Renderer 的生图配置组件保持独立，仅在 `ChannelSettings` 增加一个组件挂载点。

因此官方更新渠道表单或渠道存储时，不需要反复解决图片字段的类型与 UI 冲突。代价是“模型服务”和“生图用途”在同一页面分成两个区块，但这比把图片协议耦合进每种渠道表单更稳定，也更容易向其他图片供应商扩展。

## 生图目录 schema v2

`~/.proma/image-generation-models.json` 升级到 schema v2。目录继续只保存非敏感路由信息：

```ts
export type ImageGenerationExecutor = 'nano-banana' | 'openai-images'

interface ImageGenerationModelProfileBase {
  id: string
  name: string
  executor: ImageGenerationExecutor
  modelId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface LegacyNanoBananaImageProfile extends ImageGenerationModelProfileBase {
  executor: 'nano-banana'
}

interface ChannelImageModelProfile extends ImageGenerationModelProfileBase {
  executor: 'openai-images'
  channelId: string
}

type ImageGenerationModelProfile =
  | LegacyNanoBananaImageProfile
  | ChannelImageModelProfile

interface ImageGenerationModelsFileV2 {
  schemaVersion: 2
  profiles: ImageGenerationModelProfile[]
}
```

`modelId` 仍固化在 profile 中，而不是只按渠道模型数组索引引用。渠道模型可重排，稳定 ID 才能保证任务记录可读；保存 profile 时必须验证该 `modelId` 当前存在于所选渠道且已启用。

### v1 迁移

- v1 profile 全部是 `nano-banana`，读取时原样升级为 v2 union 的 legacy 分支；
- 迁移只在用户下一次保存生图目录时原子写入 schema v2，普通读取不立即改盘；
- 配置文件不存在时，继续根据旧 Nano Banana 凭据只读合成 `legacy-nano-banana-default`；
- 未知 schema、损坏 JSON 或含未知字段的 profile 明确失败，不覆盖原文件；
- v1 的 profile ID、名称、模型 ID、启用状态和时间戳保持不变，因此项目偏好与历史任务无需改写。

### 任务快照

`ImageGenerationModelSnapshot` 同步采用可辨识联合类型：

```ts
type ImageGenerationModelSnapshot =
  | {
      profileId: string
      name: string
      executor: 'nano-banana'
      modelId: string
    }
  | {
      profileId: string
      name: string
      executor: 'openai-images'
      channelId: string
      modelId: string
    }
```

新任务固化 `channelId`，但绝不固化 API Key。重试继续使用原快照；执行前按 `channelId` 重新读取渠道并解密当前密钥。这样密钥轮换不会破坏任务记录，渠道删除、停用或模型移除则会明确阻断执行。

旧 journal 没有 `channelId` 且 executor 为 `nano-banana` 时继续按 legacy 规则读取。任何 `openai-images` 快照缺少 `channelId` 都视为损坏数据，禁止自动执行。

## 凭据与可用性

GPT Image 2 profile 保存和执行时依赖现有渠道：

- `getChannelById(channelId)` 获取渠道、Base URL、启用状态和模型列表；
- `decryptApiKey(channelId)` 仅在主进程按需解密 API Key；
- Renderer 只接收渠道 ID、显示名称、可选模型和清洗后的不可用原因；
- API Key 不写入生图目录、Design 项目偏好、任务 journal、IPC 响应、日志或错误信息；
- Base URL 不固化进任务快照，渠道更新后重试使用当前连接配置；
- 渠道必须启用、API Key 非空、模型存在且启用，profile 才能成为 Design 可选项。

生图目录保存接口仍由主进程重新校验，Renderer 提交的渠道名、模型名或可用状态不构成可信事实。删除渠道前不需要跨文件级联删除 profile；关联 profile 保留并显示“模型配置已不存在”，防止静默改变用户选择。用户可修复渠道或显式删除 profile。

Nano Banana legacy profile 继续从 `chat-tools.json` 读取旧凭据，仅作为兼容路径。它不复制到渠道配置，也不阻塞 GPT Image 2 使用。后续可另立迁移规格把 Nano Banana 迁入统一渠道凭据，本次不扩大范围。

## GPT Image 2 HTTP 协议

默认兼容配置：

- Base URL：用户在渠道中填写，示例为 `http://100.124.186.117:8030/v1`；
- Model：`gpt-image-2`；
- Header：`Authorization: Bearer <API Key>`；
- 文生图：`POST {baseUrl}/images/generations`；
- 参考图编辑：`POST {baseUrl}/images/edits`。

调用前规范化 Base URL，去除末尾 `/`，但不擅自添加或删除用户配置中的 `/v1`。

### 文生图

无参考图时发送 JSON：

```json
{
  "model": "gpt-image-2",
  "prompt": "...",
  "size": "1024x1024",
  "n": 1
}
```

首版固定或映射以下字段：

- `model` 来自可信任务快照；
- `prompt` 来自 Agent 整理后的工具参数；
- `size` 由 Design 的画面比例和图片尺寸映射到服务支持的尺寸；
- `n` 沿用 Design 的生成数量并受现有上限约束；
- `quality`、`background`、`output_format` 仅在界面和共享契约明确支持后才发送，不写死供应商私有默认值。

### 参考图编辑

存在参考图时发送 `multipart/form-data`，包含 `model`、`prompt`、`size`、`n` 和 `image`。文件读取继续受 Design 工作区、附件归属和 `allowedRoots` 约束；任何路径越界都必须早于网络调用失败。

首版只把第一张参考图作为 `image` 发送。若任务包含多张参考图，Agent 可在提示中综合其语义，但执行器必须明确提示当前协议只提交第一张，不静默伪装成多图编辑。多图字段需基于目标服务的正式协议另行扩展。

### 响应解析

每个 `data` 项按以下顺序读取图片：

1. `b64_json`；
2. `image_base64`；
3. `base64`；
4. `url`；
5. `image_url`。

Base64 直接写入 Proma attachment；URL 响应由主进程下载后再写入本地 attachment，不把远程 URL 当作最终 Design 素材。下载必须复用任务取消信号、限制响应体大小、验证图片 MIME，并拒绝重定向到本地或私有网络地址，避免服务端请求伪造。示例 Base URL 本身可为用户明确配置的私网地址，但模型响应返回的任意下载 URL不能自动继承该信任。

执行结果统一转换为现有 `AgentToolResultImage`，后续附件归属校验、Design 素材导入、占位节点替换和历史展示无需区分供应商。

## 双阶段可信路由

```text
Design 选择生图 profile
  -> 主进程创建任务并固化 snapshot
  -> Pi Agent LLM 理解生成或编辑要求
  -> Agent 调用统一图片工具
  -> 主进程按 snapshot.executor 分派执行器
     -> nano-banana：旧 Gemini GenerateContent 路径
     -> openai-images：GPT Image 2 Images API 路径
  -> 结构化图片附件进入现有 Design 导入流程
```

现有 `AgentRunExtensions.trustedImageRoute` 继续作为唯一可信输入。工具参数不暴露 `executor`、`channelId` 或 `modelId`，Agent 只能提供 prompt、参考图、比例、尺寸和数量。

图片工具构建层从当前只注入 Nano Banana 改为注入一个统一的 Design 图片工具，或按可信 executor 注入对应实现；无论采用哪种内部组织，工具名和 Prompt 必须让 Agent 只看到一个生成/编辑能力，避免在一轮任务中选择错误供应商或重复调用。

执行顺序保持：

1. 校验任务快照格式；
2. 重新解析当前 profile；
3. 验证 executor、channelId 和 modelId 与快照一致；
4. 验证渠道、模型和凭据仍可用；
5. 验证参考图路径和输入限制；
6. 才允许发起可计费网络请求。

配置在排队后被删除、停用或改为其他模型时，任务明确失败，不回退到 Nano Banana、其他 GPT 模型或项目最新选择。

## UI 状态与交互

生图配置区块复用现有 Radix/shadcn primitives 和主题变量，不嵌套卡片。每条 profile 显示：

- 显示名称；
- 模型配置选择器；
- 模型选择器；
- 调用协议选择器；
- 启用开关与删除按钮；
- 不可用原因。

交互约束：

- 选择渠道后，模型下拉只显示该渠道中已启用的模型；
- 切换 executor 时保留名称，但清除不兼容的渠道和模型选择；
- `openai-images` 必须选择渠道与模型后才能保存；
- `nano-banana` legacy 项继续显示旧凭据来源，不伪装成渠道配置；
- 加载失败时保留最近一次成功列表和未保存编辑，提供重试；
- 渠道列表变化后重新计算可用性，但不静默改写 profile；
- 保存期间禁用重复提交，成功后通过现有广播刷新 Design 选择器；
- 键盘焦点、错误关联、窄窗口换行和深浅主题沿用当前设置页规范。

Design 页本身不新增凭据输入，只展示当前项目生图模型。没有可用模型或当前选择失效时，生成/编辑按钮禁用，并链接到“模型配置 > 生图模型”。

## IPC 与模块影响

现有四层生图目录 IPC 保留，但共享类型从 schema v1 扩展为可辨识联合类型。需要同步检查：

1. `packages/shared` 的 profile、snapshot、option 与保存输入；
2. `design-ipc` 的严格输入解析和错误清洗；
3. preload 的现有 bridge 类型；
4. Renderer 设置组件与 Design 选择器。

渠道 IPC 不新增接口。生图主进程服务直接通过 `channel-manager` 的现有只读查询和解密 API 解析可信 route，避免 Renderer 获取密钥。

关联模块影响：

- Design Job journal：新增 `openai-images` snapshot 分支，旧任务兼容读取；
- 图片工具：增加 executor 分派和 GPT Image 2 实现；
- 设置页：组件从 `ToolSettings` 移到 `ChannelSettings`，Design 聚焦入口同步修改；
- 广播：现有 Nano Banana 凭据变化广播保留；渠道创建、更新、删除后需触发生图目录可用性刷新；
- 普通 Chat/Agent：Nano Banana 工具开关逻辑不变，GPT Image 2 不作为普通工具自动启用；
- 打包：纯 TypeScript/HTTP 实现，不增加运行时依赖或 external 清单。

## 错误处理与敏感信息隔离

- 渠道不存在：`关联的模型配置已不存在`；
- 渠道停用：`关联的模型配置已停用`；
- 模型不存在或停用：`关联模型不可用`；
- API Key 缺失或解密失败：只返回可操作摘要，不带密钥、存储路径或底层安全存储内容；
- 401/403：提示检查 API Key 与服务权限；
- 404：提示检查 Base URL、`/v1` 和 Images API 支持；
- 429：提示限流，不自动切换模型；
- 5xx/网络超时：任务失败并允许按原快照重试；
- 响应无图片：明确失败，不导入文本或空附件；
- 部分图片成功：只在所有返回项均完成校验和本地写入后提交附件，避免半成品进入画布；
- 日志只记录 executor、channelId、modelId、状态码和请求 ID，不记录 API Key、完整 prompt、Base64 或用户本地路径。

所有落盘继续使用 `safe-file.ts` 原子写入。敏感字段不进入 `image-generation-models.json`、项目 preferences、Design journal 或 MEMORY。

## 性能与资源开销

- 生图目录和渠道配置均为小型 JSON，只在设置加载、配置变化和任务执行前读取，不进入画布渲染或拖动循环；
- 每个 Design 任务仍是一轮 Agent LLM 加一次生图请求，不增加隐藏模型调用；
- GPT Image 2 的 Base64 响应会产生短时字符串与 Buffer 双份内存，执行器应逐项处理并设置单图与总响应大小上限；
- URL 响应下载采用流式大小限制和任务取消信号，避免无界内存占用；
- 不新增常驻服务、子进程、Python 环境或第三方依赖；
- profile 可用性可按一次设置页加载或广播批量计算，避免每个列表行重复解密同一渠道密钥。

对现有性能的主要新增成本只发生在真正使用 GPT Image 2 时，设置页和 Design 空闲状态只增加小型配置解析。

## TDD 与 BDD 验收

实现必须先增加失败测试并确认 RED，再写最小实现转绿。

### 目录与迁移

- Given schema v1 Nano Banana profiles，When 读取目录，Then 内存中兼容为 v2 且不立即写盘；
- Given v1 目录，When 用户保存，Then 原子写入 schema v2 并保持 profile ID；
- Given `openai-images` profile 缺少 channelId，When 保存或读取，Then 严格拒绝；
- Given profile 引用不存在、停用或不含该模型的渠道，When 列出选项，Then 保留 profile 并返回清洗后的不可用原因；
- Given Renderer 伪造渠道、模型或 executor，When 保存，Then 主进程拒绝且不覆盖原文件。

### GPT Image 2 执行器

- Given 无参考图，When 执行，Then 向 `{baseUrl}/images/generations` 发送 Bearer JSON 请求；
- Given 一张参考图，When 执行，Then 向 `{baseUrl}/images/edits` 发送 multipart 请求；
- Given `b64_json`、`image_base64`、`base64` 响应，When 解析，Then 生成结构化本地图片附件；
- Given `url` 或 `image_url` 响应，When 下载，Then 校验重定向、MIME 和大小后保存附件；
- Given 非 2xx、无图片、畸形 Base64、超大响应或取消信号，When 执行，Then 无半成品附件进入 Design；
- Given 越界参考图，When 执行，Then 在 fetch 前拒绝；
- Given API Key，When 记录错误与日志，Then 任何输出都不包含密钥。

### 可信路由与任务

- Given Design 选择 GPT Image 2，When 创建任务，Then snapshot 固化 executor、channelId 和 modelId；
- Given Agent 尝试指定其他模型，When 调用图片工具，Then 实际请求仍使用可信快照；
- Given Agent LLM 失败，When 任务结束，Then 不调用 GPT Image 2；
- Given 渠道在排队后删除、停用、换模型或密钥失效，When 执行，Then 在计费请求前失败且不回退；
- Given GPT Image 2 任务失败，When 重试，Then replacement 使用原快照而非项目当前选择；
- Given旧 Nano Banana 任务，When 恢复或重试，Then 保持既有行为。

### 设置与 Design UI

- Given 打开“模型配置”，When 渲染，Then 渠道区块下显示生图模型配置且 Chat 工具页不再重复显示；
- Given 选择渠道，When 打开模型下拉，Then 只显示该渠道已启用模型；
- Given 无渠道、失效 profile 或加载失败，When 渲染，Then 展示明确空状态或错误且保留未保存输入；
- Given 从 Design 点击“前往配置”，When 设置打开，Then 聚焦“模型配置 > 生图模型”；
- Given 保存成功，When 广播到达，Then 每项目 Design 选择器刷新且不改变有效当前选择；
- Given 窄窗口、键盘导航和深浅主题，When 操作，Then 控件无重叠、焦点可见、文本不溢出。

### 回归验证

- 生图目录、Design preferences、Design Job、recovery 与 IPC 相关测试；
- Nano Banana Pi 工具、附件归属、路径守卫与 Agent 工具白名单测试；
- ChannelSettings、ToolSettings、ImageGenerationModelSettings 和 DesignInspector 组件测试；
- `bun run typecheck`；
- `bun run electron:build`；
- Electron 实机验证 GPT Image 2 文生图、参考图编辑、配置失效、任务取消、窄窗口和深浅主题。

## 验收标准

- 用户在“模型配置”完成 GPT Image 2 连接与生图用途配置，Chat 工具页不再承担 Design 生图目录；
- Design 每个项目可选择 GPT Image 2，任务始终先运行 Agent LLM，再运行所选图片执行器；
- GPT Image 2 文生图和单参考图编辑均能生成经过校验的本地 Design 素材；
- API Key 只存在于现有加密渠道配置，未复制到任何生图或任务文件；
- Nano Banana、旧 profile、旧项目偏好和旧任务记录保持兼容；
- 不修改 `ChannelModel` 或渠道 JSON schema，官方代码更新时新增冲突集中在一个设置页挂载点；
- 所有新增行为有 BDD 风格测试，类型检查、Electron 构建和关键实机路径通过。
