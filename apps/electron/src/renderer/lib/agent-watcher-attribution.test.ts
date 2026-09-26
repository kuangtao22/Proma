import { describe, expect, test } from 'bun:test'
import {
  countCommonLeadingSegments,
  extractToolActivityPaths,
  resolveWatcherPathAttribution,
  type WatcherAttributionCandidate,
} from './agent-watcher-attribution'

/** 共享根：工作区级附加目录（该工作区所有会话共享）。 */
const SHARED_ROOT = '/Users/me/Code/ChuanBei/Chebenben'

/** 构造候选会话证据。 */
function candidate(sessionId: string, activityPaths: string[], ownedRoot = SHARED_ROOT): WatcherAttributionCandidate {
  return { sessionId, ownedRoot, activityPaths }
}

describe('监听事件归属判定', () => {
  test('Given 两个会话都在共享根内活动但只有一方碰到该子目录 When 判定 Then 归属唯一写入者', () => {
    const changedPath = `${SHARED_ROOT}/chebenben-ios/Chebenben-iOS/Chebenben-iOS/Features/Ledger/QuickAdd/SheetView/QuickAddLinkedRecordSheetView.swift`
    const attribution = resolveWatcherPathAttribution(changedPath, [
      candidate('session-ios', [`${SHARED_ROOT}/chebenben-ios/Chebenben-iOS`]),
      candidate('session-backend', [`${SHARED_ROOT}/chebenben-backend/src/main/java`]),
    ])

    expect(attribution).toEqual({ kind: 'unique', sessionId: 'session-ios' })
  })

  test('Given 只有一个会话覆盖该路径 When 判定 Then 无歧义直接归属', () => {
    const changedPath = `${SHARED_ROOT}/chebenben-ios/a.swift`
    expect(resolveWatcherPathAttribution(changedPath, [
      candidate('only-one', []),
    ])).toEqual({ kind: 'unique', sessionId: 'only-one' })
  })

  test('Given 没有任何候选会话 When 判定 Then 报无法归属', () => {
    expect(resolveWatcherPathAttribution(`${SHARED_ROOT}/a.swift`, [])).toEqual({ kind: 'unknown' })
  })

  test('Given 两个会话都只停在共享根本身 When 判定 Then 如实报无法归属', () => {
    const changedPath = `${SHARED_ROOT}/chebenben-ios/a.swift`
    expect(resolveWatcherPathAttribution(changedPath, [
      candidate('session-a', [SHARED_ROOT]),
      candidate('session-b', [SHARED_ROOT]),
    ])).toEqual({ kind: 'unknown' })
  })

  test('Given 两个会话都碰到同一子目录 When 判定 Then 报多候选而不是猜一个', () => {
    const changedPath = `${SHARED_ROOT}/chebenben-ios/Chebenben-iOS/a.swift`
    expect(resolveWatcherPathAttribution(changedPath, [
      candidate('session-a', [`${SHARED_ROOT}/chebenben-ios/Chebenben-iOS`]),
      candidate('session-b', [`${SHARED_ROOT}/chebenben-ios/Chebenben-iOS/b.swift`]),
    ])).toEqual({ kind: 'ambiguous' })
  })

  test('Given 证据路径是改动文件本身 When 附加文件根取所在目录 Then 仍能归属', () => {
    const changedPath = `${SHARED_ROOT}/notes/spec.md`
    expect(resolveWatcherPathAttribution(changedPath, [
      candidate('session-notes', [changedPath], `${SHARED_ROOT}/notes`),
      candidate('session-other', [`${SHARED_ROOT}/chebenben-ios`], `${SHARED_ROOT}/notes`),
    ])).toEqual({ kind: 'unique', sessionId: 'session-notes' })
  })

  test('Given 大小写不同的 Windows 路径 When 大小写不敏感比较 Then 视为同一目录', () => {
    const changedPath = 'C:\\Work\\Repo\\Sub\\A.ts'
    expect(resolveWatcherPathAttribution(changedPath, [
      candidate('session-win', ['c:/work/repo/sub/b.ts'], 'C:/Work/Repo'),
      candidate('session-other', ['C:/Work/Repo/Other'], 'C:/Work/Repo'),
    ], true)).toEqual({ kind: 'unique', sessionId: 'session-win' })
  })
})

describe('公共目录前缀段数', () => {
  test('Given 同层但不同名的目录 When 计算 Then 不误判为公共目录', () => {
    expect(countCommonLeadingSegments('/a/bc/x.ts', '/a/bcd/y.ts')).toBe(1)
    expect(countCommonLeadingSegments('/a/b/x.ts', '/a/bd/y.ts')).toBe(1)
    expect(countCommonLeadingSegments('/a/b/x.ts', '/a/b/y.ts')).toBe(2)
  })
})

describe('工具活动路径提取', () => {
  test('Given 写类工具入参 When 提取 Then 取绝对路径字段', () => {
    expect(extractToolActivityPaths({ file_path: '/repo/src/a.ts' })).toEqual(['/repo/src/a.ts'])
  })

  test('Given 命令行里出现绝对路径 When 提取 Then 解析出命令文本中的路径', () => {
    const command = "R=/Users/me/repo/ios; python3 - <<'PY'\nfrom pathlib import Path\np=Path('/Users/me/repo/ios/Sheet.swift')\nPY"
    expect(extractToolActivityPaths({ command })).toEqual([
      '/Users/me/repo/ios',
      '/Users/me/repo/ios/Sheet.swift',
    ])
  })

  test('Given 命令里只有相对路径或 URL When 提取 Then 不产生证据', () => {
    expect(extractToolActivityPaths({ command: 'grep -n a src/index.ts; curl https://x.test/a' })).toEqual([])
  })

  test('Given 入参不是对象 When 提取 Then 返回空数组', () => {
    expect(extractToolActivityPaths(undefined)).toEqual([])
    expect(extractToolActivityPaths('file_path=/a/b')).toEqual([])
  })

  test('Given 路径条数超过上限 When 提取 Then 只保留上限内的路径', () => {
    const command = Array.from({ length: 5 }, (_v, i) => `/repo/f${i}.ts`).join(' ')
    expect(extractToolActivityPaths({ command }, 2)).toEqual(['/repo/f0.ts', '/repo/f1.ts'])
  })
})
