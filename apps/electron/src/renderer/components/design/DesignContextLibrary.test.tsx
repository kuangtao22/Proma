import { describe, expect, test } from 'bun:test'
import type { DesignAsset, DesignContextEntry } from '@proma/shared'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DesignContextLibraryView,
  createVisualStandardRegistrationInput,
  filterDesignContextEntries,
} from './DesignContextLibrary'

/** 创建资料库测试条目。 */
function createEntry(overrides: Partial<DesignContextEntry> = {}): DesignContextEntry {
  return {
    id: 'context-1',
    projectId: 'project-1',
    category: 'brand',
    kind: 'document',
    title: '品牌视觉规范',
    relativePath: 'documents/context-1.md',
    tags: ['首页', '品牌'],
    source: 'user',
    updatedAt: 1,
    ...overrides,
  }
}

/** 创建可登记为视觉标准的成功素材。 */
function createAsset(): DesignAsset {
  return {
    id: 'asset-1', filename: 'home.png', relativePath: 'assets/home.png',
    thumbnailRelativePath: 'thumbnails/home.webp', mediaType: 'image/png',
    width: 1440, height: 900, byteSize: 1024, sha256: 'hash', createdAt: 1,
    sourceJobId: 'job-1',
  }
}

/** 渲染资料库纯视图，便于稳定覆盖加载和错误状态。 */
function renderLibrary(overrides: Partial<React.ComponentProps<typeof DesignContextLibraryView>> = {}): string {
  return renderToStaticMarkup(
    <DesignContextLibraryView
      open
      entries={[]}
      loadState="ready"
      error={null}
      searchQuery=""
      category="all"
      saving={false}
      onOpenChange={() => undefined}
      onSearchQueryChange={() => undefined}
      onCategoryChange={() => undefined}
      onCreateDocument={() => undefined}
      onImportDocument={() => undefined}
      onEditEntry={() => undefined}
      onDeleteEntry={() => undefined}
      onRetry={() => undefined}
      onConfirmVisualStandard={() => undefined}
      {...overrides}
    />,
  )
}

describe('Design 创作资料库', () => {
  test('Given 条目标题标签和类别 When 搜索 Then 只返回命中的紧凑列表项', () => {
    const entries = [
      createEntry(),
      createEntry({ id: 'context-2', title: '角色设定', category: 'character', tags: ['主角'] }),
    ]

    expect(filterDesignContextEntries(entries, '首页', 'all').map((entry) => entry.id)).toEqual(['context-1'])
    expect(filterDesignContextEntries(entries, '', 'character').map((entry) => entry.id)).toEqual(['context-2'])
  })

  test('Given 加载空错误和正常资料 When 渲染 Then 保留稳定状态区和恢复动作', () => {
    expect(renderLibrary({ loadState: 'loading' })).toContain('正在加载创作资料')
    expect(renderLibrary()).toContain('暂无创作资料')
    expect(renderLibrary({ loadState: 'failed', error: '清单损坏' })).toContain('清单损坏')
    expect(renderLibrary({ loadState: 'failed', error: '清单损坏' })).toContain('重试')
    expect(renderLibrary({ entries: [createEntry()] })).toContain('品牌视觉规范')
  })

  test('Given 成功素材 When 请求采用为视觉标准 Then 先展示确认表单且输入不含路径', () => {
    const asset = createAsset()
    const html = renderLibrary({ visualStandardCandidate: asset })
    const input = createVisualStandardRegistrationInput('project-1', asset, 'reference', '首页视觉标准', '首页, 深色')

    expect(html).toContain('采用为视觉标准')
    expect(html).toContain('value="home.png"')
    expect(input).toEqual({
      projectId: 'project-1', assetId: 'asset-1', category: 'reference',
      title: '首页视觉标准', tags: ['首页', '深色'],
    })
    expect(JSON.stringify(input)).not.toContain('/assets/')
  })

  test('Given 保存中 When 渲染确认表单 Then 确认动作被禁用并显示保存反馈', () => {
    const html = renderLibrary({ visualStandardCandidate: createAsset(), saving: true })

    expect(html).toContain('正在保存')
    expect(html).toMatch(/type="submit"[^>]*disabled=""/)
  })
})
