# 独立生图供应商配置实现计划

## 目标与用户决策（2026-09-17）

把生图配置改成与音频生成同构的「独立供应商」结构，首批只兼容三家：
即梦（Dreamina）、ChatGPT（OpenAI Images）、MiniMax 图像。

用户已确认：

- 生图完全独立管理，**不再复用 LLM 渠道的 Base URL 与 API Key**；每家配置自带凭据，便于后续扩展新供应商。
- 即梦只有 CLI，登录走网页授权，交互对齐现有 ChatGPT 官方登录（设备码/浏览器授权 + 主进程持有会话），不要求用户粘贴 Cookie。

## 现状（已核对代码）

- 现有生图配置是「统一媒体 API 模型目录」`MediaApiModelProfile`，字段为 `channelId + modelId + capabilities`，只引用 LLM 渠道凭据，本身不保存任何秘密。
- 执行侧已有 OpenAI Images 与 Nano Banana 执行器；`minimax-image` / `minimax-video` 等协议只在枚举中预留，没有执行器。
- 即梦在仓库中零实现；本地 CLI（`~/.local/bin/dreamina`）是唯一入口，登录为 OAuth Device Flow：
  `dreamina login` 打印 `verification_uri` / `user_code` / `device_code`，`--headless` 可先退出随后 `login checklogin --device_code=...` 收尾，
  登录态由 CLI 自己保存，`dreamina logout` 清除。
- 即梦图像能力：`text2image`（模型版本 3.0/3.1/4.0/4.1/4.5/4.6/4.7/5.0/5.0Pro，分辨率按模型区分）、`image2image`、`image_upscale`，
  任务异步，`query_result --download_dir` 取结果，`user_credit` 可查额度。

## 数据模型（新独立目录 `~/.proma/image-generation-profiles.json`）

```ts
type ImageGenerationProvider = 'dreamina' | 'openai-images' | 'minimax'

interface ImageGenerationModelEntry {
  id: string                       // 供应商侧模型标识（即梦为 model_version）
  name?: string
  capabilities: ImageGenerationCapability[]  // text-to-image / image-to-image / upscale
  params?: Record<string, string>  // 例如即梦的 resolution_type，OpenAI 的尺寸/质量
}

interface ImageGenerationProfileBase {
  id: string
  name: string
  provider: ImageGenerationProvider
  baseUrl: string                  // 即梦无 Base URL，使用 CLI 适配层占位
  models: ImageGenerationModelEntry[]
  enabled: boolean
  createdAt: number
  updatedAt: number
  legacyMediaProfileId?: string    // 指向旧统一目录条目，仅用于迁移提示
}
```

凭据按供应商分形态，沿用音频的「密文 + 可保留」语义：

- `openai-images` / `minimax`：`apiKey`（safeStorage 加密，MiniMax 额外可选 `groupId`）。
- `dreamina`：不保存任何密文；凭据是 CLI 的本地登录态，配置只记录登录状态与 CLI 路径，登录/登出通过设备码流程驱动。

## 交互（对齐音频与渠道配置）

1. 基本信息：供应商类型、名称、服务地址（即梦隐藏）、API Key（即梦替换为「登录即梦 / 重新登录」按钮 + 设备码与 verification_uri 展示）、启用开关。
2. 已启用模型 / 可用模型：与音频一致——可用模型来自「端点拉取」或「官方内置清单」，点一下加入已启用模型。
3. 连接测试：OpenAI Images 与 MiniMax 走能力接口探测（不产图）；即梦走 `dreamina user_credit`（验证登录态与额度，不消耗额度）。
4. 旧数据迁移：现有统一目录里 `protocol = openai-images` 且引用渠道的条目，在生图页给出只读迁移提示，按新结构创建独立配置；旧条目保持不动。

## 切片划分

- **S1 合同**：Shared 类型、strict parser、provider 描述表（字段、默认端、内置模型）、schema 版本与迁移规则。
- **S2 独立 Store**：`~/.proma/image-generation-profiles.json`，safeStorage 加密、CAS、原子写、v1 迁移。
- **S3 目录与测试服务**：OpenAI Images（`/v1/models` 过滤图像模型 + 内置兜底）、MiniMax（`/v1/models` 过滤 + 内置图像模型）、即梦（内置 model_version 清单）；连接测试按上面的规则接入。
- **S4 即梦登录链路**：主进程 spawn `dreamina login --headless`（或带 `login checklogin` 收尾），把 `verification_uri` / `user_code` 事件推给渲染层，处理成功、失败、取消与已登录复用；`logout` 只清 CLI 登录态。
- **S5 IPC / Preload 四层合同**：读取、整目录 CAS 替换、连接测试、目录拉取、即梦登录/登出；sender 授权与 await 后复核沿用音频实现。
- **S6 UI + 迁移**：三级区块（基本信息 / 已启用模型 / 可用模型）、供应商动态字段、即梦登录面板、旧条目迁移提示；复用音频页的组件与样式。
- **S7 真实 Electron 验收**：扩展 smoke，覆盖三家字段切换、即梦登录面板、模型增删、布局与深浅主题，并跑定向回归、类型检查与构建。

## 执行边界

- 即梦执行器（真正提交 text2image 并落素材）本轮不接，只做配置、登录与连接测试；与音频一样先把“用哪家、哪个模型、什么参数”定义清楚。
- 不复用渠道凭据，也不改现有统一目录的写入语义；迁移只做提示与新建。
- 无新增依赖；CLI 调用通过主进程 spawn，路径可配置并做存在性校验。
