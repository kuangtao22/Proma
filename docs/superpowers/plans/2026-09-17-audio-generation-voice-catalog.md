# 音频音色列表与供应商音色目录实现计划

## 实施结果（2026-09-17 收尾，以此节为准）

计划执行中按用户反馈做了三处结构性调整，A1/A2 的原始描述已被下列结果取代：

- **数据结构是 v3 而非 v2**：`profile.models: Array<{ id, name?, voices }>`，即“模型 → 音色”两级；v1（单值 `voiceId`）与 v2（`modelId` + 扁平音色）都在读取时迁移成一条模型条目，绝不回写用户文件。
- **不再手填音色**：添加模型时自动带出该模型的音色（小米用官方内置 9 个音色；MiniMax 用已拉取的账号音色），只保留逐条移除。
- **模型清单分两类**：小米从 `/v1/models` 拉取并只保留带 `tts` 的模型；MiniMax 的 `/v1/models` 只登记对话模型，因此语音模型内置为官方 T2A 枚举（`speech-2.8-hd` 等 8 个）。
- **连接测试**接入了真实能力探测：小米读模型列表、MiniMax 读音色列表，都不生成音频；两个接口互不阻塞，只有真实上游请求全部失败才算失败。

## 背景

当前独立音频配置只有单个必填 `voiceId`，界面是一个手填输入框。用户要求把音色交互做成与 LLM 渠道“已启用模型 / 可用模型 / 从供应商获取”一致的结构：

- 上块“已启用音色”：已加入该配置的音色，可移除、可搜索。
- 下块“可用音色”：小米直接展示官方内置音色，MiniMax 点击“从供应商获取”后拉取；点条目添加到上块。
- 底部保留手填 `音色 ID` + `显示名称` + 添加。

联网核实结论（2026-09-17）：

- MiniMax 有真实接口 `POST {baseUrl}/v1/get_voice`，`{"voice_type":"all"}`，无密钥返回 `1004` 鉴权错误；返回 `system_voice.items[]`、`voice_cloning.items[]`、`voice_generation.items[]`，条目含 `voice_id`、`voice_name`、`description`。账号作用域与 GroupId 相关，配置已有可选 `groupId`。
- 小米 MiMo 官方全量文档 `https://mimo.mi.com/llms-full.txt` 只暴露 `chat/completions`、`messages`、`models`、`responses`，TTS 通过 chat/completions 的 `audio.voice` 传内置音色 ID；实测 `/v1/audio/speech`、`/v1/voices` 等一律 404，因此没有列表接口，只能内置官方固定清单。

用户决策（2026-09-17）：

- 不做“默认音色”字段；多个已启用音色时，由画布上的设置勾选使用哪个，并把可用音色开放给 agent。
- 小米配置按官方文档写：Base URL、模型 ID、内置音色表都以文档为准。

## 阶段划分

### A1：音色从单值升级为列表（含 v1→v2 迁移）

数据模型（`packages/shared/src/types/audio-generation.ts`）：

```ts
/** 已启用音色；source 只用于界面标注来源，不参与执行分支。 */
export interface AudioGenerationVoice {
  id: string
  name?: string
  source: 'builtin' | 'remote' | 'manual'
}

export interface AudioGenerationProfileBase {
  // 移除 voiceId，改为有序列表；顺序即用户添加顺序
  voices: AudioGenerationVoice[]
  // 其余字段不变
}
```

约束：

- `voices` 长度 1–64；`id` 复用稳定标识合同（`AUDIO_GENERATION_IDENTIFIER_MAX_LENGTH`，禁止保留字与非法字符）；`name` 可选、≤128；`source` 必须是三个字面量之一；未知字段 fail closed。
- 目录 `schemaVersion` 升到 `2`；读取 `1` 时把 `voiceId` 迁移为 `voices: [{ id: voiceId, name: voiceId, source: 'manual' }]`，迁移只发生在读取，不改写用户文件。
- 空 `voices` 的配置视为非法（TTS 必须至少有一个音色）；测试与写入都按此收口。

影响面（必须同步，否则类型不通过）：

- `AudioGenerationConfigStore`：解析、迁移、CAS 写入、公开投影。
- `AudioGenerationTestService`：`rebuildStrictProfile` 使用 `voices`。
- `media-ipc.ts`：旧 audio profile 投影与迁移引用校验。
- `AudioGenerationSettings.tsx`：表单从单输入框改为列表编辑器（本阶段先支持手填增删与搜索，不含目录拉取）。
- 现有测试与 smoke fixture 中所有 `voiceId` 断言。

### A2：供应商音色目录

- 描述符新增 `voiceCatalog: 'builtin' | 'remote'`；小米为 `builtin`，MiniMax 为 `remote`。
- 小米内置清单按官方文档表格内置（`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`），带官方文档版本注释，随文档变化人工同步。
- 新增 IPC `media:fetch-audio-generation-voices`：主进程用已保存密文 Key（编辑态）或草稿 Key（新建态）请求 MiniMax；HTTPS 与 URL 校验复用既有 `parseAudioGenerationBaseUrl`；15 秒超时、响应体上限、错误只回稳定错误码，不把上游正文或路径带回 Renderer。
- 结果只作为 Renderer 内存目录，不落盘、不进入配置文件、不构成“音色有效”的持久事实；重新打开表单需重新获取。
- MiniMax 返回的 `description` 只用于列表次要说明，不写进配置。

### B：画布勾选与 agent 可用音色（A 完成后再设计）

- 画布侧设置允许从各音频配置的已启用音色中勾选本次任务可用集合。
- 同一集合以只读形式暴露给 agent（供后续 TTS 执行选择），不暴露 Base URL、Key 或文件路径。
- 本阶段只做选择与暴露，不实现真实 TTS 执行器；执行器另行立项。

## 全局约束

- 使用 Bun 与既有 Radix/shadcn primitives，不新增依赖；注释与文案用中文。
- IPC 四层合同同步：`packages/shared` 类型与通道、`main/ipc.ts`、`preload`、renderer 调用与错误处理。
- 配置写入继续走 `safe-file` 原子写与整目录 CAS，不引入局部写。
- 每个切片 TDD：先写失败测试，再实现，再跑最小回归与 `bun run typecheck`。
