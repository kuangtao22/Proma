# Server Ops 数据驱动评估

日期：2026-09-07。状态：源码调研完成，待依赖授权与真实引擎验收。本文不代表数据库功能已经可用。

## 建议与用户影响

采用三个纯 JavaScript 驱动，通过现有 ssh2 `forwardOut` channel 连接目标数据库；不创建本地代理监听，不复用 SSH 登录密码。新增安装依赖及打包闭包，但不新增原生编译模块，只有打开数据源时才创建驱动连接。每次查询使用独立连接，取消后不得自动重放。

| 引擎 | 精确候选 | 许可 | SSH 接入与结果控制 | 限制 |
| --- | --- | --- | --- | --- |
| PostgreSQL | `postgres@3.4.9` | Unlicense | async custom socket，官方提供 SSH 示例；cursor 有界批次，支持 cancel | 需验证 TLS 真实主机名、只读事务、扩展权限；关闭连接不等于服务端已回滚 |
| MySQL | `mysql2@3.24.3` | MIT | custom stream 使用 SSH channel；callback query stream 逐行消费 | 禁止聚合 Promise 查询；关闭 compress，TLS 开启证书和真实 hostname 校验；DDL 可能隐式提交 |
| Redis | `ioredis@6.0.0` | MIT | custom Connector；为 SSH channel 适配 socket 方法；SCAN、GETRANGE 有界读取 | COUNT 不是结果硬上限；需限制轮次/字节/条数，禁 KEYS；不能用断开承诺命令未执行 |

调研时上述精确版本的 OSV 查询未返回已知条目；这不是完整安全审计，安装后仍应检查实际锁定依赖闭包。三个包均有持续维护的官方仓库和类型定义；安装、构建与目标平台验证尚未执行。

## 接入证据

- PostgreSQL custom socket：[官方 README 固定 revision](https://github.com/porsager/postgres/blob/e7dfa14519f363229ccc3ead7b1b2f2051937efb/README.md#custom-socket)。无需为 channel 伪造 TCP `.connect()`。
- MySQL custom stream：[官方连接实现固定 revision](https://github.com/sidorares/node-mysql2/blob/83bda806907364114946f1fd215ad34b51a1e71c/lib/base/connection.js)。配置 `compress: false`，TLS `rejectUnauthorized: true`、`verifyIdentity: true`。
- Redis Connector：[官方类型定义固定 revision](https://github.com/redis/ioredis/blob/8ed2946504a36ae9b1e186b9dccc56afcd046d78/lib/redis/RedisOptions.ts)。SSH channel 缺少的 `setNoDelay`、`setKeepAlive`、`setTimeout` 需要明确适配；TLS 使用 `tls.connect({ socket: channel, servername: realHost, rejectUnauthorized: true })`。

不采用原始 `pg` channel 直连方案，因为其 socket 合同需要额外适配；不采用 node-redis，因为缺少对应 custom stream 注入入口。

## 实施闸门

- [ ] 用户批准三个精确直接依赖。
- [ ] 独立临时引擎验证 SSH 连接、认证、TLS、权限不足、取消和资源关闭。
- [ ] 在驱动消费层证明行数/字节上限，不先聚合全量结果。
- [ ] 更新 utility external、runtime-deps 与构建测试，完成 Electron 构建。
- [ ] 自由 SQL 的可信 parser 与数据库只读角色另行验证；本次驱动授权不代表该边界已完成。

PostgreSQL/MySQL 自由 SQL 不通过字符串前缀猜测只读。Redis 使用有限命令合同；写身份和逐次批准独立于只读诊断。未完成上述验证的引擎不能标记为就绪。
