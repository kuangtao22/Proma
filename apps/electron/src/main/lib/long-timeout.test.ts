import { describe, expect, test } from 'bun:test'
import { clampTimerDelay } from './long-timeout'

describe('clampTimerDelay', () => {
  test('Given a delay beyond Node timer capacity, when scheduling, then it waits only to the maximum supported delay', () => {
    expect(clampTimerDelay(3_430_443_000)).toBe(2_147_483_647)
  })

  test('Given a normal future delay, when scheduling, then it preserves the requested delay', () => {
    expect(clampTimerDelay(60_000)).toBe(60_000)
  })
})
