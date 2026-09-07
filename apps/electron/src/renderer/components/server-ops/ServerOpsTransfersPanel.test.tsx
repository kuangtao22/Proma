import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsTransferSnapshot } from '@proma/shared'
import { ServerOpsTransfersPanel } from './ServerOpsTransfersPanel'

/** 创建公开传输快照。 */
function transfer(overrides: Partial<ServerOpsTransferSnapshot> = {}): ServerOpsTransferSnapshot {
  return {
    transferId: 'transfer-1', hostId: 'host-1', direction: 'upload', fileName: 'archive.bin', remotePath: '/srv/archive.bin',
    status: 'running', transferredBytes: 50, totalBytes: 100, createdAt: 1, updatedAt: 2, ...overrides,
  }
}

describe('服务器运维传输面板', () => {
  test('显示方向、公开文件名、进度与可取消动作', () => {
    const html = renderToStaticMarkup(<ServerOpsTransfersPanel transfers={[transfer()]} onCancel={() => undefined} />)
    expect(html).toContain('archive.bin')
    expect(html).toContain('/srv/archive.bin')
    expect(html).toContain('50%')
    expect(html).toContain('aria-label="取消传输 archive.bin"')
  })

  test('明确显示空状态、待检查和稳定错误，不渲染本地路径', () => {
    expect(renderToStaticMarkup(<ServerOpsTransfersPanel transfers={[]} onCancel={() => undefined} />)).toContain('暂无文件传输')
    const html = renderToStaticMarkup(<ServerOpsTransfersPanel transfers={[transfer({ status: 'pending-check', errorCode: 'SERVER_OPS_TRANSFER_RESULT_UNKNOWN' })]} onCancel={() => undefined} />)
    expect(html).toContain('待检查')
    expect(html).toContain('传输结果未知')
    expect(html).not.toContain('/Users/')
  })

  test.each([
    ['SERVER_OPS_AUDIT_WRITE_FAILED', '结果审计未保存'],
    ['SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED', '临时文件清理失败'],
  ] as const)('Given 已完成传输带 %s When 展示结果 Then 保留完成状态并显示警告', (warning, message) => {
    /** 成功发布后的辅助步骤故障不得被当作传输失败或静默忽略。 */
    const html = renderToStaticMarkup(<ServerOpsTransfersPanel transfers={[transfer({ status: 'succeeded', transferredBytes: 100, warning })]} onCancel={() => undefined} />)
    expect(html).toContain('已完成')
    expect(html).toContain(message)
    expect(html).not.toContain('aria-label="取消传输')
  })

  test('Given 取消后临时文件清理失败 When 显示警告 Then 不宣称文件已保存', () => {
    /** 取消可能留下待检查临时文件，辅助清理失败不能伪造发布成功。 */
    const html = renderToStaticMarkup(<ServerOpsTransfersPanel transfers={[transfer({
      status: 'failed', errorCode: 'SERVER_OPS_TRANSFER_CANCELLED', warning: 'SERVER_OPS_TRANSFER_TEMP_CLEANUP_FAILED',
    })]} onCancel={() => undefined} />)
    expect(html).toContain('传输已取消')
    expect(html).toContain('临时文件清理失败')
    expect(html).not.toContain('文件已保存')
  })
})
