import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiFileStore } from './api-file-store'

/** 在临时目录里准备文件，测试结束统一清理。 */
function fixture(): { root: string; path: (name: string) => string; write: (name: string, content: Buffer | string) => string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'api-file-store-'))
  return {
    root,
    path: (name) => join(root, name),
    write: (name, content) => { const target = join(root, name); writeFileSync(target, content); return target },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe('待上传文件引用仓库', () => {
  test('Given 常规文件 When 登记 Then 只回元数据且不含路径', () => {
    const f = fixture()
    try {
      const target = f.write('report.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))
      const store = new ApiFileStore()

      const meta = store.register('workspace', target)

      expect(meta.fileName).toBe('report.pdf')
      expect(meta.sizeBytes).toBe(6)
      expect(meta.contentType).toBe('application/pdf')
      expect(meta.ref).toMatch(/^file_[A-Za-z0-9]+$/)
      /** 路径不出现在回传元数据里。 */
      expect(JSON.stringify(meta)).not.toContain(f.root)
    } finally { f.cleanup() }
  })

  test('Given 符号链接 When 登记 Then 按真实路径展开并采用目标文件名', () => {
    const f = fixture()
    try {
      const target = f.write('secret.txt', 'hello')
      const link = f.path('looks-innocent.txt')
      symlinkSync(target, link)
      /** 真实路径与链接名都出现在磁盘上，登记结果必须用真实路径的文件名。 */
      const store = new ApiFileStore({ uuid: () => 'ref1' })

      const meta = store.register('workspace', link)

      expect(meta.fileName).toBe('secret.txt')
      expect(meta.ref).toBe('file_ref1')
      expect(store.read('workspace', meta.ref).bytes.toString()).toBe('hello')
    } finally { f.cleanup() }
  })

  test('Given 目录、悬空链接或超限文件 When 登记 Then 明确拒绝', () => {
    const f = fixture()
    try {
      const dir = f.path('folder')
      mkdirSync(dir)
      const dangling = f.path('dangling')
      symlinkSync(f.path('missing-target'), dangling)
      const big = f.write('big.bin', Buffer.alloc(64))
      const store = new ApiFileStore({ maxBytes: 16 })

      expect(() => store.register('workspace', dir)).toThrow('API_WORKBENCH_FILE_INVALID_TYPE')
      expect(() => store.register('workspace', dangling)).toThrow('API_WORKBENCH_FILE_MISSING')
      expect(() => store.register('workspace', big)).toThrow('API_WORKBENCH_FILE_TOO_LARGE')
      expect(() => store.register('workspace', f.path('nope'))).toThrow('API_WORKBENCH_FILE_MISSING')
    } finally { f.cleanup() }
  })

  test('Given 文件数量达到上限 When 继续登记 Then 拒绝', () => {
    const f = fixture()
    try {
      const first = f.write('a.txt', 'a')
      const second = f.write('b.txt', 'b')
      const store = new ApiFileStore({ maxFiles: 1 })

      expect(store.register('workspace', first).fileName).toBe('a.txt')
      expect(() => store.register('workspace', second)).toThrow('API_WORKBENCH_FILE_LIMIT')
      /** 不同 workspace 各自计数。 */
      expect(store.register('other', second).fileName).toBe('b.txt')
    } finally { f.cleanup() }
  })

  test('Given 已登记文件 When 读取 Then 回真实字节与 sha256 摘要', () => {
    const f = fixture()
    try {
      const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80])
      const target = f.write('binary.bin', bytes)
      const store = new ApiFileStore()
      const meta = store.register('workspace', target)

      const loaded = store.read('workspace', meta.ref)

      expect(loaded.bytes.equals(bytes)).toBe(true)
      expect(loaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(loaded.summary).toEqual({ fileName: 'binary.bin', sizeBytes: 5, sha256: loaded.sha256 })
    } finally { f.cleanup() }
  })

  test('Given 文件被删除或被改写 When 读取 Then fail closed 而不是发出旧内容', () => {
    const f = fixture()
    try {
      const target = f.write('doc.txt', 'v1')
      const store = new ApiFileStore()
      const removed = store.register('workspace', target).ref
      unlinkSync(target)
      expect(() => store.read('workspace', removed)).toThrow('API_WORKBENCH_FILE_UNREADABLE')

      const changed = f.write('other.txt', 'v1')
      const changedRef = store.register('workspace', changed).ref
      writeFileSync(changed, 'v2-longer')
      expect(() => store.read('workspace', changedRef)).toThrow('API_WORKBENCH_FILE_CHANGED')
    } finally { f.cleanup() }
  })

  test('Given 未知引用或跨 workspace When 读取 Then 拒绝', () => {
    const f = fixture()
    try {
      const target = f.write('a.txt', 'a')
      const store = new ApiFileStore()
      const meta = store.register('workspace', target)

      expect(() => store.read('workspace', 'file_missing')).toThrow('API_WORKBENCH_FILE_REF_NOT_FOUND')
      /** 引用在同一实例内不可跨工作区使用。 */
      expect(() => store.read('other', meta.ref)).toThrow('API_WORKBENCH_FILE_REF_NOT_FOUND')
      expect(store.metadata('other', meta.ref)).toBeUndefined()
      expect(store.metadata('workspace', meta.ref)?.fileName).toBe('a.txt')
    } finally { f.cleanup() }
  })

  test('Given 清空引用 When 再读取 Then 按失效处理', () => {
    const f = fixture()
    try {
      const target = f.write('a.txt', 'a')
      const store = new ApiFileStore()
      const meta = store.register('workspace', target)

      expect(store.clear('workspace')).toBe(1)
      expect(store.clear('workspace')).toBe(0)
      expect(() => store.read('workspace', meta.ref)).toThrow('API_WORKBENCH_FILE_REF_NOT_FOUND')
    } finally { f.cleanup() }
  })
})
