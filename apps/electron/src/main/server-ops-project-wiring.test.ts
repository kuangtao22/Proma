import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('运维项目配置事务接线', () => {
  test('Given 主进程装配 When 创建三类 Store Then 共用事务并权威检查项目引用', () => {
    /** 主进程接线源码。 */
    const source = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')
    expect(source).toContain('const serverOpsConfigTransaction = createServerOpsConfigTransaction(')
    expect(source).toContain('hasProjectReferences: (projectId) =>')
    expect(source).toContain('serverOpsHostStore.list().some((host) => host.projectId === projectId)')
    expect(source).toContain('serverOpsDataSourceStore.list().some((dataSource) => dataSource.projectId === projectId)')
    expect(source).toContain('resolveProjectId: (projectId) => serverOpsProjectStore.resolveProjectId(projectId)')
    expect(source.match(/resolveDefaultProjectId: \(\) => serverOpsProjectStore\.ensureDefaultProject\(\)/gu)).toHaveLength(2)
    /** 限定到实际数据服务装配块，校验依赖身份而不要求两个字段紧挨着。 */
    const dataServiceSetup = source.match(/const serverOpsDataService = new ServerOpsDataService\(\{([\s\S]*?)\n  \}\)/u)?.[1]
    expect(dataServiceSetup).toBeDefined()
    expect(dataServiceSetup).toContain('transaction: serverOpsConfigTransaction,')
    expect(dataServiceSetup).toContain('schemaCache: serverOpsDataSchemaCache,')
    expect(dataServiceSetup).toContain('now: Date.now,')
  })
})
