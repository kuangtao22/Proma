import { describe, expect, test } from 'bun:test'
import type { MediaRunSnapshot } from '@proma/shared'
import { MediaRunSupervisor } from './media-run-supervisor'
import type { ComfyProgressEvent } from './comfyui-progress-stream'

/** 内存运行模拟持久化任务事件，网络失败由明确开关驱动。 */
function harness() {
  let snapshot: MediaRunSnapshot = { id: 'run', projectId: 'project', revision: 1, phase: 'prepared', profileId: 'profile', profileRevision: 1,
    createdAt: 1, updatedAt: 1, outputs: [], error: null, progress: null }
  const listeners = new Set<(snapshot: MediaRunSnapshot) => void>()
  let complete = false
  let offline = false
  let collectionFailures = 0
  let eventListener: ((event: ComfyProgressEvent) => void) | undefined
  const calls = { advance: 0, reconcile: 0, subscribe: 0, release: 0, progress: 0 }
  const update = (phase: MediaRunSnapshot['phase']): MediaRunSnapshot => {
    snapshot = { ...snapshot, phase, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener(snapshot)
    return snapshot
  }
  const runs = {
    get: () => structuredClone(snapshot),
    advance: async () => { calls.advance += 1; return update('queued') },
    reconcile: async () => { calls.reconcile += 1; if (offline) throw new Error('断线');
      if (collectionFailures > 0) { collectionFailures -= 1; return update('collection-failed') }
      return update(complete ? 'succeeded' : 'running') },
    getWatchTarget: () => snapshot.phase === 'prepared' ? null : { connectionId: 'c', instanceGeneration: 'g', baseUrl: 'http://localhost', clientId: 'client', promptId: 'prompt' },
    recordProgress: () => { calls.progress += 1 },
    subscribe: (listener: (value: MediaRunSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    listRecoverable: () => snapshot.phase === 'prepared' ? [] : [snapshot],
  }
  const supervisor = new MediaRunSupervisor({ runs, pollMs: 10, stream: { subscribe: (_input, listener) => {
    calls.subscribe += 1; eventListener = listener; return () => { calls.release += 1 }
  }, dispose: () => undefined } })
  return { supervisor, calls, listeners, update, setComplete: () => { complete = true }, setCollectionFailures: (value: number) => { collectionFailures = value }, setOffline: (value: boolean) => { offline = value }, emit: (event: ComfyProgressEvent) => eventListener?.(event) }
}

describe('媒体后台运行监督', () => {
  test('Given 产物连续三次下载失败 When 网络恢复 Then 继续退避补收原任务而不重新生成', async () => {
    const fixture = harness()
    try {
      fixture.update('running')
      fixture.setCollectionFailures(3)
      fixture.setComplete()
      fixture.supervisor.recover('project')
      expect((await fixture.supervisor.wait('project', 'run', 2000)).phase).toBe('succeeded')
      expect(fixture.calls.advance).toBe(0)
      expect(fixture.calls.reconcile).toBe(4)
    } finally { fixture.supervisor.dispose() }
  })
  test('Given 同一run多个入口 When 重复start Then 只提交一次且HTTP在没有WS时完成收集', async () => {
    const fixture = harness()
    try {
      fixture.supervisor.start('project', 'run', 1)
      fixture.supervisor.start('project', 'run', 1)
      fixture.setComplete()
      expect((await fixture.supervisor.wait('project', 'run', 1000)).phase).toBe('succeeded')
      expect(fixture.calls.advance).toBe(1)
      expect(fixture.calls.reconcile).toBe(1)
      expect(fixture.calls.release).toBe(1)
      expect(fixture.listeners.size).toBe(0)
    } finally { fixture.supervisor.dispose() }
  })

  test('Given 应用恢复 When 未提交prepared与远端已提交任务 Then 只对账已提交且断线后继续', async () => {
    const fixture = harness()
    try {
      fixture.supervisor.recover('project')
      expect((await fixture.supervisor.wait('project', 'run', 20)).phase).toBe('prepared')
      expect(fixture.calls.advance).toBe(0)
      fixture.update('queued')
      fixture.setOffline(true)
      fixture.supervisor.recover('project')
      await fixture.supervisor.wait('project', 'run', 35)
      fixture.setOffline(false)
      fixture.setComplete()
      expect((await fixture.supervisor.wait('project', 'run', 1000)).phase).toBe('succeeded')
      expect(fixture.calls.advance).toBe(0)
      expect(fixture.calls.reconcile).toBeGreaterThan(1)
    } finally { fixture.supervisor.dispose() }
  })

  test('Given Agent等待取消或应用退出 When 清理 Then 结束本地等待且不取消远端任务', async () => {
    const fixture = harness()
    fixture.update('running')
    const pending = fixture.supervisor.wait('project', 'run', 30000)
    fixture.supervisor.dispose()
    expect((await pending).phase).toBe('running')
    expect(fixture.listeners.size).toBe(0)
    expect(fixture.calls.advance).toBe(0)
  })
})
