# 独立音频生成供应商配置设计

日期：2026-09-16

状态：用户已确认交互与架构方向，等待规格复核后进入实施计划。

## 结论

音频生成使用独立的供应商配置、凭据存储、连接测试和后续执行适配器，不复用 LLM Channel，也不把 TTS 配置塞入 ComfyUI 服务连接。首批供应商为小米 TTS 与 MiniMax Speech；以后新增供应商时，只扩展供应商注册表、严格配置类型和主进程适配器，不改通用列表与表单流程。

设置页一级分区调整为：

1. 生图模型
2. 音频生成
3. 服务链接
4. 本地工作流

第一阶段交付独立配置、凭据保护、供应商差异化字段和连接测试合同，不声称已经接入 Canvas 音频生成。真实生成执行器在取得并验证对应供应商的官方 TTS 请求合同后，消费稳定的音频配置 ID 接入现有媒体运行与资产链路。

## 问题与目标

当前统一 API 媒体模型目录同时声明图片、音频与视频协议，但只有 OpenAI Images 存在可执行适配器。音频条目仍引用 LLM Channel，既无法表达 TTS 专属字段，也会让 LLM `/models` 或 `/messages` 测试被误认为 TTS 可用。

本设计解决以下问题：

- 用户可以像添加 LLM 渠道一样添加、编辑、复制、删除、启停和测试音频供应商配置。
- 小米与 MiniMax 根据各自上游合同显示不同字段和校验提示。
- API Key 不进入公开目录、日志或 Renderer 的常规列表状态。
- 配置与测试结果准确区分“已保存”“已验证”和“可执行”。
- 后续增加供应商或生成执行器时不迁移现有配置，不复制整套页面。

## 非目标

第一阶段不包含以下范围：

- 不让 Canvas、Agent 工具或聊天流程直接发起 TTS 生成。
- 不实现声音克隆素材上传、长音频流式落盘或音频资产采用。
- 不复用 LLM Channel 的聊天模型列表和 Anthropic/OpenAI 请求测试。
- 不删除旧媒体目录中的音频、视频条目。
- 不引入新的第三方依赖、数据库或后台连接探测任务。

## 方案比较与决策

### 采用：独立音频供应商注册表

通用页面读取供应商描述，生成字段、默认值、校验与状态文案；Shared 与 Main 使用同一供应商判别值收窄请求。每个供应商拥有独立 tester，后续拥有独立 executor。

Shared 的判别联合与 parser 是配置合同的唯一权威来源，并导出按 Provider 键完整覆盖的公开字段描述。Renderer 只消费该公开描述生成控件和即时提示，不能扩展 Main 接受的字段；Main 不接收或信任 Renderer 传入的描述表，而是对请求重新执行 Shared parser，并用穷尽的 `Record<AudioGenerationProvider, Tester>` 分派测试。合同测试固定检查 Provider union、公开描述键和 tester 键完全一致，防止只增加 UI 或只增加 Main 分支。

为什么：音频供应商的鉴权、模型、音色、格式与测试请求会持续分化。把差异放进注册表和适配器，可以保持通用 UI 稳定，同时阻止未声明字段穿透主进程。

对用户的影响：首批只看到小米与 MiniMax；未来增加供应商时交互保持一致，已有配置无需改写。

### 不采用：复用 LLM Channel

现有 Channel 的 safeStorage、错误归一化、超时和表单交互可以作为实现参考，但 ChannelModel、模型拉取与连接测试属于聊天协议。复用其数据实体会混淆凭据所有权和能力状态。

### 不采用：通用 REST 模板

让用户填写路径、请求头映射和响应提取规则虽然接入快，但会把供应商协议细节转嫁给用户，也无法可靠验证二进制音频、异步任务或声音克隆。

## 信息架构与交互

### 一级导航

- `生图模型`：固定展示图片 API 模型，复用现有媒体模型目录、搜索和 CAS 保存。
- `音频生成`：展示新的独立音频供应商配置。
- `服务链接`：保留 ComfyUI 等服务连接能力，只调整可见文案。
- `本地工作流`：保持现有功能。

现有视频配置继续保存在统一媒体目录中，不归入生图或音频页。首版不提供视频入口；未来视频 API 具备真实执行适配后再增加独立“视频生成”分区。任何隐藏都不得删除或改写已有视频记录。

### 音频配置列表

列表提供添加、编辑、复制、删除、启停和测试连接。每项展示：

- 用户名称
- 供应商名称
- 模型 ID
- 服务地址的脱敏摘要
- 凭据是否已配置
- 最近一次当前窗口内的测试状态
- 配置支持状态：未验证、验证成功、验证失败或测试暂不可用

测试状态只保存在发起测试的 Renderer 窗口，不跨窗口广播，也不持久化为供应商可用事实；应用重启、配置身份字段变化、凭据变化、复制或删除后恢复为未验证。列表不自动测试，不轮询上游。

### 添加与编辑

交互复用 LLM 渠道的页面结构、按钮、加载态、错误条、危险地址确认和离开脏表单保护，但不复用 Channel 数据或聊天协议逻辑。

通用字段：

- 名称
- 供应商
- 服务地址
- API Key
- 模型 ID
- 音色 ID
- 启用状态

供应商字段由严格描述表提供：

- 小米 TTS：首版包含通用字段；取得官方接口合同后，只通过描述表增加已证实的 App ID、区域或其它字段，不预先猜测。
- MiniMax Speech：显示可选 Group ID，并保留供应商专属模型与音色约束；tester 依据经过验证的官方合同决定当前账号是否必须填写。

编辑已有配置时不回显已保存 API Key；空白表示保留原秘密，显式“替换凭据”后才接受新值。复制配置不得复制秘密，复制项必须重新输入 API Key。

切换供应商时清空不属于新供应商的专属字段、模型和音色，保留名称、启用状态及用户明确保留的通用服务地址。保存前再次由 Shared/Main 严格解析，Renderer 校验只用于即时反馈。

## 数据模型

新增以下独立判别联合：

```ts
type AudioGenerationProvider = 'xiaomi' | 'minimax'

interface AudioGenerationProfileBase {
  id: string
  name: string
  provider: AudioGenerationProvider
  baseUrl: string
  modelId: string
  voiceId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface XiaomiAudioGenerationProfile extends AudioGenerationProfileBase {
  provider: 'xiaomi'
  legacyMediaProfileId?: string
}

interface MiniMaxAudioGenerationProfile extends AudioGenerationProfileBase {
  provider: 'minimax'
  groupId?: string
  legacyMediaProfileId?: string
}
```

新 Provider 值属于独立音频命名空间，与旧统一媒体协议 `minimax-speech` 没有身份关系。新配置使用独立 store 内的 UUID；Canvas 模型范围和旧媒体目录继续只读取旧 Profile，不会因为存在同名供应商而把新配置视为可执行模型。

持久化文件合同固定为：

```ts
interface AudioGenerationCatalogFile {
  schemaVersion: 1
  revision: number
  profiles: AudioGenerationPersistedProfile[]
}

interface AudioGenerationPersistedProfile {
  profile: XiaomiAudioGenerationProfile | MiniMaxAudioGenerationProfile
  encryptedApiKey: string
}

type AudioGenerationCredentialUpdate =
  | { mode: 'preserve' }
  | { mode: 'replace'; apiKey: string }

interface ReplaceAudioGenerationCatalogRequest {
  expectedRevision: number
  profiles: Array<{
    profile: XiaomiAudioGenerationProfile | MiniMaxAudioGenerationProfile
    credentialUpdate: AudioGenerationCredentialUpdate
  }>
}
```

`encryptedApiKey` 只属于 Main 持久化模型。公开摘要使用 `credentialConfigured` 代替秘密。供应商专属字段采用显式联合和允许字段列表，不使用无约束 `Record<string, unknown>` 作为业务合同。

目录使用单一 catalog revision 和完整替换 CAS。所有新增、编辑、删除、启停和旧配置迁移都提交 `expectedRevision + profiles[]`；每个 Profile 同时提交 `credentialUpdate: preserve | replace`。Main 在同一临界区读取当前 revision、验证所有稳定 ID、合并旧密文或加密新 Key，再原子写完整目录。新 ID 或复制 ID 不允许 `preserve`；revision 冲突不写文件，并向 Renderer 返回明确冲突要求重新加载。删除是从新音频目录中物理移除，原子替换后密文不再存在于当前文件；删除不影响旧统一媒体目录。

## 持久化与凭据安全

- 配置文件固定为 `getConfigDir()/audio-generation-profiles.json`。
- JSON 修改使用 `safe-file.ts` 的原子写封装。
- API Key 使用 Electron `safeStorage` 加密为 `encryptedApiKey` 后写入独立配置文件；不引用 LLM Channel，也不建立跨文件 credentialRef。凭据不可写入 `MEMORY.md`、日志、测试快照或错误详情。
- 列表、读取和事件广播只返回公开摘要，不解密秘密。
- 未保存直接测试时，明文秘密只存在于本次 IPC 请求和 Main 的局部变量中；不得进入持久化、日志、事件、错误对象或长期缓存，测试 Promise 收口后从业务状态和请求注册表移除。
- 编辑时空 Key 保留旧密文；新增与复制必须提供新 Key 才能测试需要鉴权的供应商。
- 错误归一化必须移除 URL 用户信息、查询参数、认证头、Token 和可能回显秘密的上游正文。
- `safeStorage` 不可用时仍允许读取公开目录；任何新增配置、替换 Key、测试已保存配置都明确失败且不写文件。只修改非秘密字段时可以保留既有密文完成 CAS；未保存直接测试可使用当前表单 Key，不调用 safeStorage。
- Base URL 只接受 `http:` 或 `https:`，拒绝 URL username/password。列表只展示 `URL.origin`，不展示 path、query 或 hash；非法 URL 不允许保存。错误文案使用供应商名称和归一化状态，不回显完整 URL。

## IPC 与运行边界

遵循四层 IPC 合同：Shared 类型和通道、Main handler、Preload bridge、Renderer 调用。最小能力为：

- 读取公开目录
- 新增或更新配置
- 删除配置
- 启停配置
- 使用未保存草稿直接测试
- 测试已保存配置
- 取消指定测试请求

Renderer 只提交用户意图和草稿。Main 负责 strict parse、URL 安全检查、凭据合并、加密、CAS、测试分派和错误脱敏。

音频设置读取固定返回一个组合结果：

```ts
interface AudioGenerationSettingsResult {
  catalog: AudioGenerationPublicCatalog
  legacyAudioProfiles: LegacyAudioProfileSummary[]
  legacyWarning?: string
}
```

Main 分别读取独立音频目录与旧统一媒体目录，旧条目只投影稳定 ID、名称、协议、模型 ID、启用状态和原始顺序，不包含渠道秘密。旧目录读取或解析失败时，独立音频目录仍可使用，同时返回脱敏 `legacyWarning` 并禁用迁移操作；重复旧 ID 视为旧目录损坏，同样不提供迁移目标。独立目录读取失败则整个请求失败，不能用空目录覆盖。旧条目按原持久化顺序展示，独立 catalog revision 只管理新目录，不受旧目录变化影响。

每次测试由 Renderer 生成 `requestId`。Main 使用 `webContents.id + requestId` 注册 AbortController；相同配置或草稿的新测试先通过取消 IPC 终止旧请求，窗口销毁和应用退出清理该 owner 的全部请求。测试响应携带 `requestId`、配置 revision 或草稿摘要；Renderer 仅接受仍匹配当前活动测试的结果，迟到响应直接丢弃。

供应商 tester 接口返回统一结果：`success`、`failed`、`cancelled` 或 `unavailable`。`unavailable` 表示尚无经过验证的官方测试合同，不能转换为成功或普通网络失败。

测试必须满足：

- 15 秒以内的有界超时和 Abort 清理。
- 遵守现有代理配置。
- 使用供应商真实 TTS 鉴权或最小 TTS 请求；不能用 LLM `/messages` 成功证明 TTS 可用。
- 不持久化测试生成的音频，不把测试音频登记为媒体资产。
- 如测试会产生费用，按钮和结果明确提示，且只由用户显式触发。

可验证测试合同固定为：优先调用官方提供、能直接证明 TTS 权限且不生成音频的能力接口；没有这种接口时，使用当前模型和音色发起固定文本“Proma 连接测试”的最小 TTS 请求。缺少模型或音色时禁用测试并指出缺失字段。异步供应商在同一 15 秒预算内完成首次提交后，每 1 秒最多查询一次、最多查询 12 次；没有终态则超时且不自动重试。响应音频最多读取 1 MiB 用于验证媒体类型或签名，随后丢弃；测试产物不落盘、不登记资产。如官方合同无法证明以上流程，tester 不发网络请求并返回 `unavailable`。

小米公开接口合同尚未取得时，配置可保存，tester 返回“测试暂不可用/缺少已验证接口合同”。MiniMax 也必须以实施时核实的官方 TTS 文档为准，不能从现有 LLM Channel 猜测请求。

## 旧配置兼容

统一媒体目录中的旧 `minimax-speech` Profile 保持原样，不自动复制 LLM Channel 的秘密，也不删除。

音频页读取到旧条目时展示只读迁移提示，允许用户以旧名称、模型 ID 和启用状态创建新的 MiniMax 独立配置；服务地址、Group ID、音色和 API Key 由用户确认。迁移创建的新配置记录 `legacyMediaProfileId`；Main 只在该引用首次出现或被修改时，接受真实存在且协议为 `minimax-speech` 的旧 Profile ID。后续旧条目被其它版本删除时，已保存引用仍可保留，不会阻断无关配置更新。只要组合读取结果中存在旧条目且当前新目录中存在该引用，对应提示视为已处理。删除新配置后提示重新出现。迁移不反向删除或改写旧条目，避免旧版本应用读取时发生数据损失。

旧音频条目继续保持 `configuration-only`，不能因为新页面存在就变为可执行。

## 错误、状态与可访问性

- 加载、保存、测试和删除使用独立 busy 状态，避免一次测试锁死其它列表操作。
- 测试结果绑定配置 ID、catalog revision 和草稿摘要；字段变化后立即失效，迟到结果不得覆盖新草稿。
- 保存冲突、鉴权失败、超时、上游限流、接口未开放和本地安全拒绝使用不同文案。
- 表单字段具有可见标签、错误关联和键盘顺序；供应商切换后焦点保持在供应商控件附近。
- 深浅主题复用现有 Radix/shadcn primitives 与主题变量；不新增自定义颜色体系。
- 空状态说明当前没有音频配置，并提供唯一“添加音频 API”主操作。

## 性能与资源预算

- 列表加载只读取一个有界 JSON 文件，不解密全部凭据。
- 连接测试仅用户触发；同一配置同一时间最多一个活动测试，新测试按 requestId 先取消旧测试。
- 测试响应只读取错误所需的有界正文；若 TTS 测试返回音频，必须在读取前设置字节上限并立即丢弃。
- 不新增后台轮询、文件 watcher、数据库、常驻连接或预热请求。
- 分区切换复用已加载目录或按既有缓存策略读取，不能因四个页签重复解密凭据。

## 测试策略

实施遵循 BDD 与测试先行，至少覆盖：

### Shared

- 小米与 MiniMax 正常配置解析。
- 供应商字段错配、未知字段、缺失字段、非法 URL 和超长输入拒绝。
- 公开摘要不包含秘密。
- 完整替换请求严格校验 expectedRevision、稳定 ID、credentialUpdate 和 legacyMediaProfileId。

### Main 与存储

- API Key 加密落盘、读取脱敏、空 Key 保留和复制不复制秘密。
- 原子写、CAS 冲突、损坏文件、数据根不可用及 safeStorage 不可用。
- tester 正确分派、超时、取消、代理、鉴权失败、限流和错误脱敏。
- 无官方合同的供应商返回 `unavailable`，不发送猜测请求。
- URL 拒绝内嵌凭据，列表摘要只含 origin，错误不回显 path/query/hash。

### IPC 与 Preload

- 四层通道参数严格解析，错误不会泄露秘密。
- requestId 取消、窗口销毁或应用退出时取消活动测试。
- 迟到测试结果无法覆盖新 revision。

### Renderer

- 四个一级分区的文案、键盘切换和焦点恢复。
- 生图页只显示图片模型；音频页只显示独立音频配置。
- 小米与 MiniMax 切换时字段、默认值和校验正确变化。
- 编辑留空保留 Key、复制要求新 Key、测试 loading/success/failure/unavailable 状态。
- 空状态、加载态、保存冲突、删除确认和窄宽布局。
- 旧 MiniMax 配置只读提示、legacyMediaProfileId 处理状态与非破坏迁移流程。

### 真实 Electron 场景

- 在 1440x900 与 1024x768 两种 viewport、深浅主题中打开媒体设置，键盘依次切换四个一级分区，断言焦点与内容一致且无横向溢出。
- 新建小米配置后切到 MiniMax，断言供应商专属字段替换、旧专属值清空，返回列表后公开 DOM 不含 API Key。
- 复制配置，断言 API Key 为空且未填写时不能发起鉴权测试。
- 启动测试后修改模型或音色并再次测试，注入旧请求迟到响应，断言界面只显示新 requestId 的结果。
- 注入旧 `minimax-speech` Profile，完成迁移后提示消失；删除新配置后提示恢复，旧目录正文不变。

## 验收标准

1. 设置页稳定展示四个确认的一级分区，现有生图、服务连接业务和本地工作流行为不回退；服务连接业务的可见页签名称按用户要求改为“服务链接”。
2. 用户可以独立添加小米和 MiniMax 音频配置，供应商切换展示不同字段。
3. API Key 加密保存，列表、日志和测试错误不出现明文秘密。
4. 未保存草稿和已保存配置都能进入各自 tester；无真实合同的供应商明确返回不可测试。
5. 旧音频、视频配置不被删除或静默改写。
6. 当前阶段不会让 Canvas 把配置项视为可执行 TTS 模型。
7. 定向测试、Electron 类型检查及相关 main/preload/renderer 构建通过；按上述固定 viewport 和交互场景完成真实 Electron 验证。

## 后续阶段

取得供应商官方接口合同后，为每个供应商分别完成：

1. 固定 endpoint、鉴权、请求、响应、计费测试与能力描述。
2. 新增 TTS executor，处理取消、超时、大小上限、响应签名和安全落盘。
3. 让音频配置 ID 成为媒体运行来源，复用现有任务状态、恢复和资产登记。
4. Canvas 按供应商能力展示文本、音色、格式和声音克隆输入。
5. 用真实服务或官方 sandbox 验证，不以 mock 测试替代可调用性声明。自动化测试使用脱敏 fixture 与网络替身且为必跑；真实服务测试仅在用户提供凭据和官方环境时手动执行，缺失时必须报告验证空缺，不阻塞配置基础设施交付，也不得宣称供应商可调用。
