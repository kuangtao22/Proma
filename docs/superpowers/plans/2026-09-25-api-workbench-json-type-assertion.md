# 接口工作台 B10：JSON 类型断言（实施计划）

> 前置：阶段 A 的「尚未交付」清单里写着 **JSON 类型断言与响应差异比较尚未交付**。本轮只做前者：`json-type`。
> 状态：**已交付**（提交信息 `接口工作台（B10）：JSON 类型断言`，验收记录见第 5 节）。

## 1. 要解决的问题

现有的 JSON 断言只能比**取值**（`json-value`）或判**存在**（`json-exists`）。但接口契约里最常见的约束是「这个字段必须是 number / 必须是对象」，取值会变、类型不该变。缺了这条，模型和人都只能用「值等于某个具体数字」这类脆弱断言去近似，改一次数据就得改断言。

## 2. 设计

- 新增断言类型 `json-type`：`path` 用既有只读 JSON 路径（点路径 + `[下标]`），`expected` 是六种类型名之一：`string` / `number` / `boolean` / `object` / `array` / `null`（比较前 trim + 小写，`Number` 也接受）。
- **类型判定复用现有 JSON 读取器**：它为了不改写大整数，会把 JSON 数字 token 保留成带标记的字符串。因此类型判定必须由 `api-json-path` 统一回答（`number` 的判定要认那个标记），不能在断言里再写一遍 `typeof`——否则大整数会被误判成 string。
- 失败语义与既有断言一致：路径不存在 → 判失败（`actual` 为空）；正文不完整或超预览范围 → 判「无法验证」而不是通过；`expected` 不是六种类型之一 → 判失败并给出可读原因。
- 界面：断言类型的下拉里新增「JSON 类型」，期望值输入框的占位文案列出六种类型名。
- Agent：`api_prepare_request` 的断言枚举（含用例内断言）同步放开 `json-type`。

## 3. 明确不做

- 不新增「JSON 类型不符时打印实际值」这类会泄漏正文的细节，`actual` 只暴露类型名。
- 响应差异比较、schema 校验（JSON Schema）、数组元素类型逐个校验（留待后续增量）。

## 4. 验收标准

1. 单测：六种类型各自判对；大整数判成 number 而不是 string；路径不存在、`expected` 非法、正文被截断三种情况都判失败并带原因。
2. 共享合同：解析器接受 `kind: 'json-type'`（含用例内断言），仍拒绝未知类型。
3. 真实 Electron 端到端：一条请求上分别声明「必须是 number」（通过）与「必须是 string」（失败），两条结论都来自真实响应；运行记录里的 `expected`/`actual` 不泄漏正文取值。
4. 定向回归、`bun run typecheck`、`bun run electron:build` 通过。

## 5. 已交付与验收记录（2026-09-25）

已交付行为：

- 断言类型新增 `json-type`，`expected` 取六种类型名之一（trim + 小写，`Number` 也接受）。
- **类型判定集中在 `api-json-path`**：`apiJsonValueType` 认得出「数字保留前缀」，因此 `900719925474099312345` 判 `number` 而不是 `string`；断言层不再自己写 `typeof`。
- 失败语义与其他断言一致：路径不存在 → 失败并提示「在正文 JSON 里找不到该路径」；`expected` 不是六种类型名 → 失败并列出可选值；正文被截断或超预览范围 → 判「无法验证」而不是通过。`actual` 只暴露类型名，不回显正文取值。
- 界面断言下拉新增「JSON 类型」，期望值占位提示六个类型名；Agent 的断言枚举（含用例内断言）同步放开。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 定向回归（共享合同 / IPC / 主进程工作台 / 工作台界面 / agent 组件 / preload） | 837 pass / 0 fail，100 文件 | `/tmp/proma-api-b10-targeted.log` |
| `bun run typecheck` | 7 workspace 全部通过 | `/tmp/proma-api-b10-typecheck.log` |
| `bun run electron:build` | 通过，仅既有 EventKit 告警 | `/tmp/proma-api-b10-build.log` |
| 真实 Electron 端到端（`api-workbench-smoke.ts`） | PASS，网络调用 15 次：同一条请求上「`id` 必须是 number」通过、「`id` 必须是 string」失败，结论来自真实响应；断言结果里不含 20 位大整数原文 | `/tmp/proma-api-b10-smoke.log` |
