import { expect, test } from 'bun:test'
import { PROMA_DOWNLOAD_URL, PROMA_RELEASE_REPOSITORY } from './release-config'

test('fork Release 来源统一指向 kuangtao22/Proma', () => {
  expect(PROMA_RELEASE_REPOSITORY).toEqual({
    owner: 'kuangtao22',
    repo: 'Proma',
    webUrl: 'https://github.com/kuangtao22/Proma',
  })
})

test('更新下载入口统一指向 Proma 官方下载页', () => {
  expect(PROMA_DOWNLOAD_URL).toBe('https://proma.cool/download')
})
