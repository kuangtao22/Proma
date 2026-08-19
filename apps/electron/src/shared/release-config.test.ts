import { expect, test } from 'bun:test'
import { PROMA_RELEASE_REPOSITORY } from './release-config'

test('fork Release 来源统一指向 kuangtao22/Proma', () => {
  expect(PROMA_RELEASE_REPOSITORY).toEqual({
    owner: 'kuangtao22',
    repo: 'Proma',
    webUrl: 'https://github.com/kuangtao22/Proma',
  })
})
