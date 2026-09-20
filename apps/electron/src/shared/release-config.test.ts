import { expect, test } from 'bun:test'
import {
  PROMA_DOWNLOAD_URL,
  PROMA_OFFICIAL_RELEASE_REPOSITORY,
  PROMA_RELEASE_REPOSITORY,
} from './release-config'

test('fork Release 来源统一指向 kuangtao22/Proma', () => {
  expect(PROMA_RELEASE_REPOSITORY).toEqual({
    owner: 'kuangtao22',
    repo: 'Proma',
    webUrl: 'https://github.com/kuangtao22/Proma',
  })
})

test('更新下载入口统一指向 fork 的最新 Release 页面', () => {
  expect(PROMA_DOWNLOAD_URL).toBe(`${PROMA_RELEASE_REPOSITORY.webUrl}/releases/latest`)
})

test('官方 Release 历史统一指向迁移后的 proma-ai/Proma', () => {
  expect(PROMA_OFFICIAL_RELEASE_REPOSITORY).toEqual({
    owner: 'proma-ai',
    repo: 'Proma',
    webUrl: 'https://github.com/proma-ai/Proma',
  })
})
