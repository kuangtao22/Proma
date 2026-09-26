import { describe, expect, test } from 'bun:test'
import {
  classifyAgentFileChange,
  groupAgentFileChangesByCategory,
  MAX_TRACKED_AGENT_RUNS,
  mergeTurnFilePaths,
  resolveAgentRunFileChanges,
  upsertAgentRunFileChanges,
  type AgentRunFileChanges,
} from './agent-run-file-changes'

/** 构造一条运行记录，供定位与合并用例复用。 */
function run(startedAt: number, overrides: Partial<AgentRunFileChanges> = {}): AgentRunFileChanges {
  return {
    runId: String(startedAt),
    startedAt,
    paths: [],
    observed: true,
    ...overrides,
  }
}

describe('本轮文件改动分桶', () => {
  test('Given 新运行 When 写入监听器路径 Then 建立记录并保留跟踪标记', () => {
    const records = upsertAgentRunFileChanges([], {
      runId: '1000',
      startedAt: 1000,
      observed: true,
      path: '/project/a.ts',
    })

    expect(records).toEqual([{
      runId: '1000',
      startedAt: 1000,
      paths: ['/project/a.ts'],
      observed: true,
    }])
  })

  test('Given 路径已存在 When 再次写入 Then 返回原引用，避免高频事件重复渲染', () => {
    const first = upsertAgentRunFileChanges([], {
      runId: '1000',
      startedAt: 1000,
      observed: true,
      path: '/project/a.ts',
    })
    const second = upsertAgentRunFileChanges(first, {
      runId: '1000',
      startedAt: 1000,
      observed: true,
      path: '/project/a.ts',
    })

    expect(second).toBe(first)
  })

  test('Given Windows 大小写不同的同一路径 When 写入 Then 只保留首次出现的写法', () => {
    const first = upsertAgentRunFileChanges([], {
      runId: '1000', startedAt: 1000, observed: true, path: 'C:\\Project\\Report.md',
    }, true)
    const second = upsertAgentRunFileChanges(first, {
      runId: '1000', startedAt: 1000, path: 'c:\\project\\report.md',
    }, true)

    expect(second).toBe(first)
    expect(second[0]!.paths).toEqual(['C:\\Project\\Report.md'])
  })

  test('Given 记录已被事后补建 When 再次声明已跟踪 Then 不升级跟踪标记', () => {
    const later = upsertAgentRunFileChanges([], {
      runId: '1000', startedAt: 1000, observed: false, path: '/project/a.ts',
    })
    const upgraded = upsertAgentRunFileChanges(later, {
      runId: '1000', startedAt: 1000, observed: true, path: '/project/b.ts',
    })

    expect(upgraded[0]!.observed).toBe(false)
    expect(upgraded[0]!.paths).toEqual(['/project/a.ts', '/project/b.ts'])
  })

  test('Given 记录超过上限 When 继续写入 Then 丢弃最旧记录', () => {
    let records: AgentRunFileChanges[] = []
    for (let index = 0; index <= MAX_TRACKED_AGENT_RUNS; index += 1) {
      records = upsertAgentRunFileChanges(records, {
        runId: String(index),
        startedAt: index,
        observed: true,
        path: `/project/${index}.ts`,
      })
    }

    expect(records).toHaveLength(MAX_TRACKED_AGENT_RUNS)
    expect(records[0]!.startedAt).toBe(1)
  })

  test('Given 端态时间 When 关闭记录 Then 写入结束时间且不覆盖已有值', () => {
    const opened = upsertAgentRunFileChanges([], {
      runId: '1000', startedAt: 1000, observed: true, path: '/project/a.ts',
    })
    const closed = upsertAgentRunFileChanges(opened, {
      runId: '1000', startedAt: 1000, endedAt: 5000,
    })
    const closedAgain = upsertAgentRunFileChanges(closed, {
      runId: '1000', startedAt: 1000, endedAt: 9000,
    })

    expect(closed[0]!.endedAt).toBe(5000)
    expect(closedAgain).toBe(closed)
  })

  test('Given 上一轮未收到完成事件 When 新一轮开始 Then 补上上一轮结束时间', () => {
    const opened = upsertAgentRunFileChanges([], {
      runId: '1000', startedAt: 1000, observed: true, path: '/project/a.ts',
    })
    const nextRun = upsertAgentRunFileChanges(opened, {
      runId: '5000', startedAt: 5000, observed: true,
    })

    expect(nextRun[0]!.endedAt).toBe(5000)
    expect(nextRun[1]!.endedAt).toBeUndefined()
  })
})

describe('turn 与本轮运行的归属', () => {
  test('Given 连续两轮 When 定位第一轮 turn Then 命中第一轮而非更晚开始的第二轮', () => {
    const records = [
      run(1000, { endedAt: 1100, paths: ['/project/a.ts'] }),
      run(1200, { endedAt: 1300, paths: ['/project/b.ts'] }),
    ]

    // 第一轮 turn 的首条 assistant 消息出现在 1050，远早于第二轮开始时间。
    expect(resolveAgentRunFileChanges(records, 1050)?.paths).toEqual(['/project/a.ts'])
    expect(resolveAgentRunFileChanges(records, 1250)?.paths).toEqual(['/project/b.ts'])
  })

  test('Given 首条消息延迟到本轮结束前 When 定位 Then 仍落在本轮区间内', () => {
    const records = [
      run(1000, { endedAt: 20_000, paths: ['/project/slow.ts'] }),
      run(21_000, { endedAt: 22_000, paths: ['/project/next.ts'] }),
    ]

    expect(resolveAgentRunFileChanges(records, 15_000)?.paths).toEqual(['/project/slow.ts'])
  })

  test('Given 尚未收到终态 When turn 创建时间在开始之后 Then 视为仍在进行', () => {
    const records = [run(1000, { paths: ['/project/running.ts'] })]

    expect(resolveAgentRunFileChanges(records, 12_000)?.paths).toEqual(['/project/running.ts'])
  })

  test('Given 早于全部记录的历史 turn When 定位 Then 不归属任何本轮', () => {
    const records = [run(1000, { endedAt: 1100 })]

    expect(resolveAgentRunFileChanges(records, 500)).toBeUndefined()
  })

  test('Given 落盘时间戳略晚于完成事件 When 定位 Then 容差内仍归属本轮', () => {
    const records = [run(1000, { endedAt: 1100, paths: ['/project/a.ts'] })]

    expect(resolveAgentRunFileChanges(records, 2600)?.paths).toEqual(['/project/a.ts'])
  })

  test('Given turn 创建时间远晚于本轮结束 When 定位 Then 不把空闲期改动算进本轮', () => {
    const records = [run(1000, { endedAt: 1100 })]

    expect(resolveAgentRunFileChanges(records, 9000)).toBeUndefined()
  })

  test('Given 缺失或非法创建时间 When 定位 Then 返回未定义以走工具入参回退', () => {
    const records = [run(1000, { endedAt: 1100 })]

    expect(resolveAgentRunFileChanges(records, undefined)).toBeUndefined()
    expect(resolveAgentRunFileChanges(records, Number.NaN)).toBeUndefined()
  })
})

describe('路径合并', () => {
  test('Given 工具路径与监听器路径重叠 When 合并 Then 按工具顺序去重', () => {
    expect(mergeTurnFilePaths(
      ['/project/a.ts', '/project/b.ts'],
      ['/project/b.ts', '/project/generated.md'],
    )).toEqual(['/project/a.ts', '/project/b.ts', '/project/generated.md'])
  })

test('Given 空路径项 When 合并 Then 忽略空值', () => {
    expect(mergeTurnFilePaths(['', '/project/a.ts'], [''])).toEqual(['/project/a.ts'])
  })
})

describe('本轮文件改动分类', () => {
  test('Given 常见源码与脚本 When 分类 Then 归入代码', () => {
    expect(classifyAgentFileChange('/project/src/BSJSEngine.swift')).toBe('code')
    expect(classifyAgentFileChange('/project/src/bridge.ts')).toBe('code')
    expect(classifyAgentFileChange('/project/scripts/regression.py')).toBe('code')
    expect(classifyAgentFileChange('/project/styles/main.scss')).toBe('code')
    expect(classifyAgentFileChange('/project/Dockerfile')).toBe('code')
  })

  test('Given 配置与文档 When 分类 Then 归入配置与文档', () => {
    expect(classifyAgentFileChange('/project/README.md')).toBe('docs')
    expect(classifyAgentFileChange('/project/tsconfig.json')).toBe('docs')
    expect(classifyAgentFileChange('/project/.github/workflows/ci.yml')).toBe('docs')
  })

  test('Given 构建产物与生成文件 When 分类 Then 归入资源与生成物', () => {
    expect(classifyAgentFileChange('/project/node_modules/pkg/index.js')).toBe('artifact')
    expect(classifyAgentFileChange('/project/dist/app.min.js')).toBe('artifact')
    expect(classifyAgentFileChange('/project/build/main.js.map')).toBe('artifact')
    expect(classifyAgentFileChange('/project/out/pb/service_pb2.py')).toBe('artifact')
    expect(classifyAgentFileChange('/project/assets/icon.png')).toBe('artifact')
    expect(classifyAgentFileChange('/project/bun.lock')).toBe('artifact')
  })

  test('Given 点文件 When 分类 Then 归入配置与文档', () => {
    expect(classifyAgentFileChange('/project/.gitignore')).toBe('docs')
    expect(classifyAgentFileChange('/project/.env.local')).toBe('docs')
  })

  test('Given 无法判断的扩展名 When 分类 Then 归入其他而不猜成代码', () => {
    expect(classifyAgentFileChange('/project/data/model.xyz')).toBe('other')
    expect(classifyAgentFileChange('/project/LICENSE')).toBe('other')
    expect(classifyAgentFileChange('')).toBe('other')
  })

  test('Given 混合改动 When 分组 Then 按代码、配置、生成物顺序返回且不含空分组', () => {
    const groups = groupAgentFileChangesByCategory([
      '/project/LICENSE',
      '/project/src/BSJSEngine.swift',
      '/project/README.md',
      '/project/dist/app.min.js',
    ])

    expect(groups.map((group) => group.category)).toEqual(['code', 'docs', 'artifact', 'other'])
    expect(groups.map((group) => group.paths)).toEqual([
      ['/project/src/BSJSEngine.swift'],
      ['/project/README.md'],
      ['/project/dist/app.min.js'],
      ['/project/LICENSE'],
    ])
  })

  test('Given 只有代码改动 When 分组 Then 只返回代码分组', () => {
    const groups = groupAgentFileChangesByCategory(['/project/src/a.ts', '/project/src/b.ts'])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.label).toBe('代码')
    expect(groups[0]!.paths).toEqual(['/project/src/a.ts', '/project/src/b.ts'])
  })
})
