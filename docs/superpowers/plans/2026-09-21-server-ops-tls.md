# 服务器运维数据库 TLS 兼容优化

用户已确认执行：对齐常用客户端的连接体验，自动填写校验主机名并展示真实连接加密状态。

## 设计与影响

- TLS 模式扩展为 disabled / preferred / required / verify；新建 MySQL 默认 preferred，已有配置不迁移、不降低原策略。
- MySQL preferred 先请求 TLS，仅在服务端握手明确不支持 TLS 且尚未认证时允许一次明文连接；TLS、证书、认证、网络错误均不回退，不重放查询。
- required 加密但不校验证书身份；verify 校验证书链与数据库主机名。Redis 无能力协商，拒绝 preferred。SQLite 仍只使用 SSH 文件读取。
- disabled 保留仅 SSH 或私网地址直连的限制；新增模式允许远程域名直连。
- probe / diagnostics 增加可选 tlsStatus（plaintext / encrypted / verified），仅成功的网络连接返回。展示为本次测试或读取状态，不能把配置模式当作协商结果；SSH 内层明文不等同于整个 SSH 通道明文。
- 证书主机名默认跟随数据库地址，支持用户覆盖，不能填入跳板地址。
- 复核发现 mysql2 3.24.4 将 IP 校验名的 SNI 省略，经 SSH 时可能退而按 localhost 校验证书。因此 MySQL verify 的身份字段限定为证书 DNS 名，TCP 端点仍允许 IP；仅含 IP SAN 的证书暂不支持该模式。旧配置保持可读，表单、主进程与 utility 在认证前阻止此配置并要求修正；Redis 使用显式身份回调，不受此限制。
- 共享解析器、utility 协议、主进程投影、preload 解析及 renderer 同步；既有授权指纹已包含 TLS 配置。
- 无新增依赖、持久连接或后台轮询；正常 TLS 不增加查询，preferred 不支持 TLS 时最多多一次建连，沿用整体超时、取消及并发限额。

## 执行与验证

- [x] 共享合同、runtime 协议、主进程转发与安全校验的 BDD 测试及实现。
- [x] 表单模式、自动主机名、编辑兼容、真实状态展示的 BDD 测试及实现。
- [x] MySQL / Redis 驱动真实 TCP/TLS 夹具，验证加密、无 TLS 回退、错误不降级、取消与清理。
- [x] 定向测试、全工作区类型检查、Electron 构建及独立复核。
- [x] 更新开发客户端和 MEMORY；说明本地协议验证与实际远程实例验证的区别。

## 验证结果

- 运维相关 98 个文件：1,264 pass / 0 fail，日志 `/private/tmp/proma-tls-final-tests.log`；7 个工作区类型检查全部通过，日志 `/private/tmp/proma-tls-types.log`。
- MySQL 真实 STARTTLS 在 Electron Node 子进程验证，Bun 测试自动构建并启动该子进程：preferred/required 加密、可信证书 verify、错误 DNS 与非信任证书在认证前拒绝、TLS 协议损坏和认证失败无回退、握手停滞可取消。测试 CA 仅加入子进程，不修改系统信任。没有跳过用例。
- 回环无 TLS MySQL 验证首次不认证、只允许第二条独立通道明文、只执行一次版本查询；两次尝试共享实际约 15 秒总预算。Redis required 的真实加密与 verify 自签失败通过；修复 ioredis 将证书错误覆盖为连接关闭的分类问题。
- 隔离完整 Electron 构建通过，日志 `/private/tmp/proma-tls-build.log`；最终证书输入编辑修正后前端再次构建通过，日志 `/private/tmp/proma-tls-renderer-final-build.log`。`git diff --check` 通过；独立安全复核通过。
- 当前工作区五个 Electron bundle 已重建，`server-ops-reader` 开发实例已重启（PID 99559），IPC 注册成功，本地前端 HTTP 200。安装版保持运行。
- 未访问用户真实 RDS/远程数据库；GUI 点击未作端到端验收，界面由 Hook/静态渲染测试、构建与启动检查覆盖。未提交、推送或发布。
