import { describe, expect, test } from 'bun:test'
import {
  DREAMINA_LOGIN_MESSAGES,
  parseDreaminaCliInput,
  parseDreaminaLoginPollResult,
  parseDreaminaLoginRequestInput,
  parseDreaminaLoginStartInput,
  parseDreaminaLoginStartResult,
  parseDreaminaLogoutResult,
  parseDreaminaStatus,
} from './dreamina-login'

describe('即梦登录 Shared 合同', () => {
  test('Given 合法与非法输入 When 解析 Then 只接受声明的字段', () => {
    expect(parseDreaminaCliInput({})).toEqual({})
    expect(parseDreaminaCliInput({ cliPath: ' /opt/dreamina ' })).toEqual({ cliPath: '/opt/dreamina' })
    expect(() => parseDreaminaCliInput({ cliPath: '/opt/dreamina', extra: 1 })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    expect(parseDreaminaLoginStartInput({ relogin: true })).toEqual({ relogin: true })
    expect(() => parseDreaminaLoginStartInput({ relogin: 'yes' })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    expect(parseDreaminaLoginRequestInput({ requestId: ' dreamina-1 ' })).toEqual({ requestId: 'dreamina-1' })
    expect(() => parseDreaminaLoginRequestInput({ requestId: '  ' })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })

  test('Given 已登录状态 When 解析 Then 必须带合法额度与固定文案', () => {
    expect(parseDreaminaStatus({
      state: 'loggedIn',
      credit: 987,
      message: DREAMINA_LOGIN_MESSAGES.statusLoggedIn,
    })).toEqual({ state: 'loggedIn', credit: 987, message: DREAMINA_LOGIN_MESSAGES.statusLoggedIn })
    /** 已登录却缺少额度、或非登录态却带额度都必须拒绝。 */
    expect(() => parseDreaminaStatus({ state: 'loggedIn', credit: null, message: DREAMINA_LOGIN_MESSAGES.statusLoggedIn }))
      .toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    expect(() => parseDreaminaStatus({ state: 'loggedOut', credit: 1, message: DREAMINA_LOGIN_MESSAGES.statusLoggedOut }))
      .toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })

  test('Given 非登录状态 When 解析 Then 只允许各自的固定文案', () => {
    expect(parseDreaminaStatus({ state: 'loggedOut', credit: null, message: DREAMINA_LOGIN_MESSAGES.statusLoggedOut }).state)
      .toBe('loggedOut')
    expect(parseDreaminaStatus({ state: 'cliMissing', credit: null, message: DREAMINA_LOGIN_MESSAGES.cliMissing }).state)
      .toBe('cliMissing')
    expect(parseDreaminaStatus({ state: 'unknown', credit: null, message: DREAMINA_LOGIN_MESSAGES.timeout }).state)
      .toBe('unknown')
    /** 任意上游正文不能冒充固定文案，避免把 CLI 输出穿过 IPC。 */
    expect(() => parseDreaminaStatus({ state: 'unknown', credit: null, message: '上游原文' }))
      .toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })

  test('Given 设备码结果 When 解析 Then 校验授权地址与有效期', () => {
    const pending = parseDreaminaLoginStartResult({
      state: 'pending',
      requestId: 'dreamina-1',
      verificationUri: 'https://jimeng.jianying.com/login',
      userCode: 'ABCD-1234',
      expiresInSeconds: 600,
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })
    expect(pending.state).toBe('pending')
    /** 非 http(s) 地址与超长有效期都必须拒绝。 */
    expect(() => parseDreaminaLoginStartResult({
      state: 'pending',
      requestId: 'dreamina-1',
      verificationUri: 'javascript:alert(1)',
      userCode: 'ABCD-1234',
      expiresInSeconds: 600,
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    expect(() => parseDreaminaLoginStartResult({
      state: 'pending',
      requestId: 'dreamina-1',
      verificationUri: 'https://jimeng.jianying.com/login',
      userCode: 'ABCD-1234',
      expiresInSeconds: 86_401,
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })

  test('Given 已复用与失败结果 When 解析 Then 只接受固定文案', () => {
    expect(parseDreaminaLoginStartResult({ state: 'reused', message: DREAMINA_LOGIN_MESSAGES.reused }).state).toBe('reused')
    expect(parseDreaminaLoginStartResult({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.cliMissing }).state).toBe('failed')
    expect(() => parseDreaminaLoginStartResult({ state: 'failed', message: '原始 stderr' }))
      .toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })

  test('Given 轮询与退出结果 When 解析 Then 状态与文案必须匹配', () => {
    expect(parseDreaminaLoginPollResult({
      requestId: 'dreamina-1',
      state: 'success',
      message: DREAMINA_LOGIN_MESSAGES.success,
    }).state).toBe('success')
    /** 成功状态不允许携带失败或等待文案。 */
    expect(() => parseDreaminaLoginPollResult({
      requestId: 'dreamina-1',
      state: 'success',
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    expect(() => parseDreaminaLoginPollResult({
      requestId: 'dreamina-1',
      state: 'unknown',
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    expect(parseDreaminaLogoutResult({ state: 'loggedOut', message: DREAMINA_LOGIN_MESSAGES.logoutSucceeded }).state)
      .toBe('loggedOut')
    expect(parseDreaminaLogoutResult({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.logoutFailed }).state)
      .toBe('failed')
    expect(() => parseDreaminaLogoutResult({ state: 'loggedOut', message: DREAMINA_LOGIN_MESSAGES.logoutFailed }))
      .toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })
})
