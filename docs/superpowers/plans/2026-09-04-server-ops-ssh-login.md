# 运维模块真实 SSH 登录实施计划

日期：2026-09-04
设计：`docs/superpowers/specs/2026-09-04-server-ops-ssh-login-design.md`

## 目标

以最小完整纵切面实现真实 SSH 登录和交互终端，同时证明 Host Key、凭据隔离与输出背压边界。

## 任务

1. 依赖与打包 Gate
   - 固定安装 `ssh2@1.17.0` 和 `@types/ssh2@1.15.6`。
   - 新增 SSH runtime build/watch，并更新 external dependency sync。
   - 测试 optional native binding 不进入同步闭包，增加 `.node` 扫描。

2. Shared 合同与迁移
   - 先写失败测试覆盖密码认证、`credentialRef`、连接状态、Host Key candidate 和 PTY 流 DTO。
   - 从公开主机 schema 移除 `keyPath`，增加兼容旧记录的迁移入口。
   - 所有 parser 拒绝额外字段、秘密字段和越界尺寸。

3. 凭据与信任 Store
   - 先写失败测试覆盖内存密码、safeStorage 密文、Linux `basic_text` fail closed、删除和脱敏。
   - 实现 `ServerOpsCredentialStore`，秘密只在主进程 API 内返回。
   - 先写失败测试覆盖 unknown/trusted/changed 和 endpoint 变化。
   - 实现原子写的 `ServerOpsHostTrustStore`。

4. SSH utility runtime
   - 先写协议与纯函数失败测试：指纹计算、连接配置、错误映射、背压与清理。
   - 实现 `server-ops-runtime.ts`、SSH transport 和 `ServerOpsRuntimeClient`。
   - unknown 仅返回 candidate；确认后由主进程 fresh-read 并发起新连接。

5. 四层 IPC
   - 扩展 shared channel、主进程 registrar、preload bridge 和类型声明。
   - 覆盖未授权 sender、秘密字段拒绝、事件订阅清理和连接 owner 校验。

6. Renderer 登录与终端
   - 增加独立 Jotai 连接状态，不持久化秘密。
   - 实现认证弹窗、记住密码、首次指纹确认、changed 阻断、连接/断开按钮。
   - 复用 xterm primitives 渲染远程 PTY，覆盖 input、resize、ACK、exit 和空状态。

7. 验证与收尾
   - 运行定向测试、secret canary 扫描、`bun run typecheck`、`bun run electron:build`。
   - 扫描同步后的 SSH 依赖闭包和构建产物，确认无 `.node`。
   - 启动开发版完成 UI 与真实本地 SSH fixture 冒烟；无法提供 fixture 时明确记录验证缺口。
   - 更新 `MEMORY.md` 的架构决策与本次约束。
