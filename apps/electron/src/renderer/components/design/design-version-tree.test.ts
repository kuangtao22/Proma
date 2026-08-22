import { describe, expect, test } from 'bun:test'
import type { DesignAsset } from '@proma/shared'
import { buildDesignVersionTree } from './design-version-tree'

/** 创建版本树测试所需的最小素材。 */
function createAsset(overrides: Partial<DesignAsset>): DesignAsset {
  return {
    id: 'asset',
    filename: 'image.png',
    relativePath: 'assets/image.png',
    thumbnailRelativePath: 'thumbnails/image.png',
    mediaType: 'image/png',
    width: 100,
    height: 100,
    byteSize: 100,
    sha256: 'hash',
    createdAt: 1,
    ...overrides,
  }
}

describe('Design 素材版本树', () => {
  test('Given 父子素材 When 构建版本树 Then 保持根到子顺序并标识当前项', () => {
    const tree = buildDesignVersionTree([
      createAsset({ id: 'root' }),
      createAsset({ id: 'child', parentAssetId: 'root' }),
      createAsset({ id: 'grandchild', parentAssetId: 'child' }),
    ], 'child')

    expect(tree.map(({ id, current, children }) => ({
      id,
      current,
      children: children.map((child) => ({
        id: child.id,
        current: child.current,
        children: child.children.map((grandchild) => grandchild.id),
      })),
    }))).toEqual([{
      id: 'root',
      current: false,
      children: [{ id: 'child', current: true, children: ['grandchild'] }],
    }])
  })

  test('Given 缺失父项 When 构建版本树 Then 将素材作为稳定根节点', () => {
    const tree = buildDesignVersionTree([
      createAsset({ id: 'orphan', parentAssetId: 'missing' }),
      createAsset({ id: 'root' }),
    ], null)

    expect(tree.map((node) => node.id)).toEqual(['orphan', 'root'])
  })

  test('Given 循环 parentAssetId When 构建版本树 Then 循环节点均作为根且不递归崩溃', () => {
    const tree = buildDesignVersionTree([
      createAsset({ id: 'a', parentAssetId: 'b' }),
      createAsset({ id: 'b', parentAssetId: 'a' }),
      createAsset({ id: 'self', parentAssetId: 'self' }),
    ], null)

    expect(tree).toHaveLength(3)
    expect(tree.map((node) => node.id)).toEqual(['a', 'b', 'self'])
    expect(tree.every((node) => node.children.length === 0)).toBe(true)
  })
})
