import { describe, expect, test } from 'bun:test'
import {
  applyServerOpsDiscoveredCredential,
  discoverServerOpsLocalCredentials,
  parseContainerEnvironment,
  parseDockerContainerList,
  parsePodmanContainerList,
} from './server-ops-local-credential-discovery'
import type { ServerOpsContainerInspection, ServerOpsContainerSummary } from './server-ops-local-credential-discovery'

/** 目标的固定连接参数：本机 13307，与现场案例一致。 */
const target = { address: '127.0.0.1', port: 13307, engine: 'mysql' } as const

/**
 * 构造一个只返回固定容器与环境变量的夹具。
 *
 * @param containers 容器清单；null 表示本机没有可用容器运行时
 * @param environments 容器名到环境变量的映射
 * @returns 可注入的探测实现，同时记录读取过哪些容器
 */
function createInspection(
  containers: ServerOpsContainerSummary[] | null,
  environments: Record<string, string[] | null> = {},
): ServerOpsContainerInspection & { readNames: string[] } {
  /** 依次记录读取过的容器名，用于断言非法容器名不会进入读取路径。 */
  const readNames: string[] = []
  return {
    readNames,
    listContainers: async () => containers,
    readContainerEnv: async (containerName) => {
      readNames.push(containerName)
      return environments[containerName] ?? null
    },
  }
}

/** 现场案例的容器：发布 127.0.0.1:13307，环境里同时有 root 与业务账号口令。 */
const localMySqlContainer: ServerOpsContainerSummary[] = [
  { name: 'chebenben-local-mysql', ports: [{ hostIp: '127.0.0.1', hostPort: 13307 }] },
]

describe('本机数据源凭据发现', () => {
  test('Given 内网或公网地址 When 发现凭据 Then 明确拒绝而不是按端口猜测', async () => {
    const inspection = createInspection(localMySqlContainer, {
      'chebenben-local-mysql': ['MYSQL_ROOT_PASSWORD=secret'],
    })
    for (const address of ['172.16.10.198', '10.0.0.5', 'db.internal', '203.0.113.9']) {
      await expect(discoverServerOpsLocalCredentials({ ...target, address }, inspection))
        .rejects.toThrow('SERVER_OPS_DATA_CREDENTIAL_ADDRESS_UNSUPPORTED')
    }
    /** 被拒的地址不得触发任何容器读取。 */
    expect(inspection.readNames).toEqual([])
  })

  test('Given 容器发布同一端口但主机地址不同 When 发现 Then 不得串到该容器', async () => {
    const inspection = createInspection([
      { name: 'other-host-mysql', ports: [{ hostIp: '192.168.1.20', hostPort: 13307 }] },
    ], { 'other-host-mysql': ['MYSQL_ROOT_PASSWORD=other'] })
    expect(await discoverServerOpsLocalCredentials(target, inspection)).toEqual({ candidates: [] })
    expect(inspection.readNames).toEqual([])
  })

  test('Given 容器发布在所有网卡 When 发现 Then 回环目标仍然命中', async () => {
    const inspection = createInspection([
      { name: 'all-interfaces-mysql', ports: [{ hostIp: '0.0.0.0', hostPort: 13307 }] },
    ], { 'all-interfaces-mysql': ['MYSQL_ROOT_PASSWORD=secret'] })
    const result = await discoverServerOpsLocalCredentials(target, inspection)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.id).toBe('all-interfaces-mysql|root')
  })

  test('Given MySQL 容器 When 发现 Then 同时给出 root 与业务账号且不带口令值', async () => {
    const inspection = createInspection(localMySqlContainer, {
      'chebenben-local-mysql': ['MYSQL_ROOT_PASSWORD=root-secret', 'MYSQL_USER=chebenben', 'MYSQL_PASSWORD=app-secret', 'MYSQL_DATABASE=chebenben'],
    })
    const result = await discoverServerOpsLocalCredentials(target, inspection)
    expect(result.candidates).toEqual([
      {
        id: 'chebenben-local-mysql|root',
        label: '容器 chebenben-local-mysql 的 MYSQL_ROOT_PASSWORD',
        username: 'root',
        hasPassword: true,
        origin: 'container-env',
        privilege: 'superuser',
      },
      {
        id: 'chebenben-local-mysql|user',
        label: '容器 chebenben-local-mysql 的 MYSQL_USER / MYSQL_PASSWORD',
        username: 'chebenben',
        hasPassword: true,
        origin: 'container-env',
        privilege: 'user',
      },
    ])
    /** 候选里绝不能出现口令字段，否则一次发现就把多组明文送进渲染层。 */
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  test('Given PostgreSQL 与 Redis 容器 When 发现 Then 按引擎映射账号与权限等级', async () => {
    const postgres = createInspection(
      [{ name: 'pg', ports: [{ hostIp: '127.0.0.1', hostPort: 15432 }] }],
      { pg: ['POSTGRES_PASSWORD=pg-secret'] },
    )
    const postgresResult = await discoverServerOpsLocalCredentials({ address: 'localhost', port: 15432, engine: 'postgresql' }, postgres)
    expect(postgresResult.candidates[0]).toMatchObject({ username: 'postgres', privilege: 'superuser' })

    const postgresCustom = createInspection(
      [{ name: 'pg', ports: [{ hostIp: '127.0.0.1', hostPort: 15432 }] }],
      { pg: ['POSTGRES_USER=app', 'POSTGRES_PASSWORD=pg-secret'] },
    )
    const customResult = await discoverServerOpsLocalCredentials({ address: '127.0.0.1', port: 15432, engine: 'postgresql' }, postgresCustom)
    expect(customResult.candidates[0]).toMatchObject({ username: 'app', privilege: 'user' })

    const redis = createInspection(
      [{ name: 'cache', ports: [{ hostIp: '127.0.0.1', hostPort: 16379 }] }],
      { cache: ['REDIS_PASSWORD=redis-secret'] },
    )
    const redisResult = await discoverServerOpsLocalCredentials({ address: '127.0.0.1', port: 16379, engine: 'redis' }, redis)
    expect(redisResult.candidates[0]).toEqual({
      id: 'cache|password',
      label: '容器 cache 的 REDIS_PASSWORD',
      hasPassword: true,
      origin: 'container-env',
      privilege: 'unknown',
    })
  })

  test('Given 没有可用容器运行时或容器名非法 When 发现 Then 返回空候选且不读取任何容器', async () => {
    expect(await discoverServerOpsLocalCredentials(target, createInspection(null))).toEqual({ candidates: [] })

    /** 伪造一个带 shell 元字符的容器名，断言它不会进入读取路径。 */
    const hostile = createInspection(
      [{ name: 'evil; rm -rf /', ports: [{ hostIp: '127.0.0.1', hostPort: 13307 }] }],
      { 'evil; rm -rf /': ['MYSQL_ROOT_PASSWORD=secret'] },
    )
    expect(await discoverServerOpsLocalCredentials(target, hostile)).toEqual({ candidates: [] })
    expect(hostile.readNames).toEqual([])
  })

  test('Given 容器环境读取失败 When 发现 Then 跳过该容器而不是报错', async () => {
    const inspection = createInspection(localMySqlContainer, { 'chebenben-local-mysql': null })
    expect(await discoverServerOpsLocalCredentials(target, inspection)).toEqual({ candidates: [] })
  })

  test('Given 界面点选某个候选 When 取回凭据 Then 只返回该候选的账号与口令', async () => {
    const inspection = createInspection(localMySqlContainer, {
      'chebenben-local-mysql': ['MYSQL_ROOT_PASSWORD=root-secret', 'MYSQL_USER=chebenben', 'MYSQL_PASSWORD=app-secret'],
    })
    expect(await applyServerOpsDiscoveredCredential({ ...target, candidateId: 'chebenben-local-mysql|user' }, inspection))
      .toEqual({ username: 'chebenben', password: 'app-secret' })
  })

  test('Given 候选已不存在 When 取回凭据 Then 报稳定错误码并由界面提示重新发现', async () => {
    const inspection = createInspection(localMySqlContainer, { 'chebenben-local-mysql': ['MYSQL_ROOT_PASSWORD=root-secret'] })
    await expect(applyServerOpsDiscoveredCredential({ ...target, candidateId: 'chebenben-local-mysql|user' }, inspection))
      .rejects.toThrow('SERVER_OPS_DATA_CREDENTIAL_CANDIDATE_NOT_FOUND')
  })
})

describe('容器运行时输出解析', () => {
  test('Given podman ps 的 JSON When 解析 Then 读出容器名与发布端口', () => {
    const stdout = JSON.stringify([
      { Names: ['chebenben-local-mysql'], Ports: [{ host_ip: '127.0.0.1', host_port: 13307, container_port: 3306, protocol: 'tcp' }] },
      { Names: ['other'], Ports: [{ host_ip: '0.0.0.0', host_port: 8080, container_port: 80, protocol: 'tcp' }] },
      { Names: [], Ports: [] },
    ])
    expect(parsePodmanContainerList(stdout)).toEqual([
      { name: 'chebenben-local-mysql', ports: [{ hostIp: '127.0.0.1', hostPort: 13307 }] },
      { name: 'other', ports: [{ hostIp: '0.0.0.0', hostPort: 8080 }] },
    ])
  })

  test('Given docker ps 的逐行 JSON When 解析 Then 正确拆出宿主端口', () => {
    const stdout = [
      JSON.stringify({ Names: 'chebenben-local-mysql', Ports: '127.0.0.1:13307->3306/tcp, 0.0.0.0:8080->80/tcp' }),
      JSON.stringify({ Names: 'no-ports', Ports: '' }),
      'not-json',
    ].join('\n')
    expect(parseDockerContainerList(stdout)).toEqual([
      { name: 'chebenben-local-mysql', ports: [{ hostIp: '127.0.0.1', hostPort: 13307 }, { hostIp: '0.0.0.0', hostPort: 8080 }] },
      { name: 'no-ports', ports: [] },
    ])
  })

  test('Given 输出损坏 When 解析 Then 一律降级为空结果而不是抛错', () => {
    expect(parsePodmanContainerList('{oops')).toEqual([])
    expect(parseDockerContainerList('{oops')).toEqual([])
    expect(parseContainerEnvironment('{oops')).toBeNull()
    expect(parseContainerEnvironment('"not-array"')).toBeNull()
  })

  test('Given inspect 的环境变量输出 When 解析 Then 只保留字符串条目', () => {
    expect(parseContainerEnvironment('["MYSQL_ROOT_PASSWORD=secret", 42]')).toEqual(['MYSQL_ROOT_PASSWORD=secret'])
  })
})
