import { describe, expect, test } from 'bun:test'
import { DREAMINA_LOGIN_MESSAGES } from '@proma/shared'
import {
  ImageGenerationDreaminaService,
  type DreaminaCliRun,
  type DreaminaCliRunResult,
} from './image-generation-dreamina-service'

/** 便于断言的可编程 CLI 替身：按顺序返回预设结果并记录调用参数。 */
function createRunner(results: DreaminaCliRunResult[]): {
  run: DreaminaCliRun
  calls: { args: readonly string[]; cliPath: string }[]
} {
  const calls: { args: readonly string[]; cliPath: string }[] = []
  return {
    calls,
    run: async (args, cliPath) => {
      calls.push({ args, cliPath })
      return results.shift() ?? { exitCode: 0, stdout: '', stderr: '' }
    },
  }
}

/** 构造一次成功的 CLI 调用结果。 */
function ok(stdout: string): DreaminaCliRunResult {
  return { exitCode: 0, stdout, stderr: '' }
}

/** 构造一次失败的 CLI 调用结果。 */
function failed(stdout: string, exitCode = 1): DreaminaCliRunResult {
  return { exitCode, stdout, stderr: '' }
}

/** 设备码登录的三要素输出，格式取自即梦 CLI 自身的格式串。 */
const LOGIN_MATERIAL = [
  'verification_uri: https://jimeng.jianying.com/ai-tool/login/oauth',
  'user_code: ABCD-1234',
  'device_code: device-secret-token',
  'expires_in: 600',
].join('\n')

describe('即梦 CLI 服务', () => {
  test('Given 已登录账号 When 查询状态 Then 返回额度且不泄露出参', async () => {
    const { run, calls } = createRunner([ok('{"total_credit":987,"user_id":110830683917}\n')])
    const service = new ImageGenerationDreaminaService({ run })
    const status = await service.status({})
    expect(status).toEqual({ state: 'loggedIn', credit: 987, message: DREAMINA_LOGIN_MESSAGES.statusLoggedIn })
    expect(calls).toEqual([{ args: ['user_credit'], cliPath: 'dreamina' }])
  })

  test('Given CLI 缺失或输出无法识别 When 查询状态 Then 分别给出可操作与未知文案', async () => {
    const missing = new ImageGenerationDreaminaService({
      run: createRunner([{ exitCode: 1, stdout: '', stderr: '', failureCode: 'cliMissing' }]).run,
    })
    expect((await missing.status({})).state).toBe('cliMissing')

    const garbled = new ImageGenerationDreaminaService({ run: createRunner([ok('登录成功但没有 JSON')]).run })
    expect(await garbled.status({})).toEqual({
      state: 'unknown',
      credit: null,
      message: DREAMINA_LOGIN_MESSAGES.statusUnknown,
    })
  })

  test('Given 登录态已失效 When 查询状态 Then 判定为未登录而不是未知', async () => {
    const service = new ImageGenerationDreaminaService({ run: createRunner([failed('登录已过期，请重新登录')]).run })
    expect(await service.status({})).toEqual({
      state: 'loggedOut',
      credit: null,
      message: DREAMINA_LOGIN_MESSAGES.statusLoggedOut,
    })
  })

  test('Given 自定义 CLI 路径 When 调用 Then 全部命令使用该路径', async () => {
    const { run, calls } = createRunner([ok('{"total_credit":1}')])
    const service = new ImageGenerationDreaminaService({ run })
    await service.status({ cliPath: '/opt/dreamina' })
    expect(calls[0]!.cliPath).toBe('/opt/dreamina')
  })

  test('Given 已登录 When 发起登录 Then 复用现有登录态且不签发设备码', async () => {
    const { run, calls } = createRunner([ok('已复用当前本地 OAuth 登录态。\n')])
    const service = new ImageGenerationDreaminaService({ run })
    expect(await service.startLogin(7, {})).toEqual({ state: 'reused', message: DREAMINA_LOGIN_MESSAGES.reused })
    expect(calls[0]!.args).toEqual(['login', '--headless'])
    expect(service.activeLoginCount).toBe(0)
  })

  test('Given 设备码输出 When 发起登录 Then 返回 user_code 与授权地址且不暴露 device_code', async () => {
    const { run } = createRunner([ok(LOGIN_MATERIAL)])
    const service = new ImageGenerationDreaminaService({ run })
    const result = await service.startLogin(7, { relogin: true })
    expect(result.state).toBe('pending')
    if (result.state !== 'pending') throw new Error('expected pending')
    expect(result.userCode).toBe('ABCD-1234')
    expect(result.verificationUri).toBe('https://jimeng.jianying.com/ai-tool/login/oauth')
    expect(result.expiresInSeconds).toBe(600)
    /** device_code 属于凭据，绝不能穿过 IPC。 */
    expect(JSON.stringify(result)).not.toContain('device-secret-token')
    expect(service.activeLoginCount).toBe(1)
  })

  test('Given 缺少设备码材料 When 发起登录 Then 直接失败且不登记状态', async () => {
    const { run } = createRunner([failed('登录已被拒绝')])
    const service = new ImageGenerationDreaminaService({ run })
    expect(await service.startLogin(7, {})).toEqual({
      state: 'failed',
      message: DREAMINA_LOGIN_MESSAGES.denied,
    })
    expect(service.activeLoginCount).toBe(0)
  })

  test('Given 仍在等待授权 When 轮询 Then 保持 pending 且设备码可继续使用', async () => {
    const { run, calls } = createRunner([
      ok(LOGIN_MATERIAL),
      failed('authorization_pending'),
    ])
    const service = new ImageGenerationDreaminaService({ run })
    const started = await service.startLogin(7, {})
    if (started.state !== 'pending') throw new Error('expected pending')
    const polled = await service.pollLogin(7, { requestId: started.requestId })
    expect(polled).toEqual({
      requestId: started.requestId,
      state: 'pending',
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })
    /** 轮询把 device_code 传给 CLI，但不出现在返回值里。 */
    expect(calls[1]!.args).toEqual(['login', 'checklogin', '--device_code=device-secret-token', '--poll=8'])
    expect(JSON.stringify(polled)).not.toContain('device-secret-token')
    expect(service.activeLoginCount).toBe(1)
  })

  test('Given 输出无法识别 When 轮询 Then 保守保持 pending 而不是误报失败', async () => {
    const { run } = createRunner([ok(LOGIN_MATERIAL), failed('未知的上游响应')])
    const service = new ImageGenerationDreaminaService({ run })
    const started = await service.startLogin(7, {})
    if (started.state !== 'pending') throw new Error('expected pending')
    expect((await service.pollLogin(7, { requestId: started.requestId })).state).toBe('pending')
  })

  test('Given 授权完成 When 轮询 Then 返回成功并释放设备码', async () => {
    const { run } = createRunner([ok(LOGIN_MATERIAL), ok('OAuth 登录成功。\n')])
    const service = new ImageGenerationDreaminaService({ run })
    const started = await service.startLogin(7, {})
    if (started.state !== 'pending') throw new Error('expected pending')
    expect(await service.pollLogin(7, { requestId: started.requestId })).toEqual({
      requestId: started.requestId,
      state: 'success',
      message: DREAMINA_LOGIN_MESSAGES.success,
    })
    expect(service.activeLoginCount).toBe(0)
    /** 终态后同一个 requestId 不再可用。 */
    expect((await service.pollLogin(7, { requestId: started.requestId })).message)
      .toBe(DREAMINA_LOGIN_MESSAGES.requestUnknown)
  })

  test('Given 设备码已过期 When 轮询 Then 不再调用 CLI 且报过期', async () => {
    const { run, calls } = createRunner([ok(LOGIN_MATERIAL)])
    let now = 1_000
    const service = new ImageGenerationDreaminaService({ run, now: () => now, deviceCodeTtlMs: 5_000 })
    const started = await service.startLogin(7, {})
    if (started.state !== 'pending') throw new Error('expected pending')
    now += 6_000
    const polled = await service.pollLogin(7, { requestId: started.requestId })
    expect(polled.state).toBe('failed')
    expect(polled.message).toBe(DREAMINA_LOGIN_MESSAGES.expired)
    expect(calls).toHaveLength(1)
    expect(service.activeLoginCount).toBe(0)
  })

  test('Given 其它窗口的设备码 When 轮询 Then 按未知会话拒绝', async () => {
    const { run } = createRunner([ok(LOGIN_MATERIAL)])
    const service = new ImageGenerationDreaminaService({ run })
    const started = await service.startLogin(7, {})
    if (started.state !== 'pending') throw new Error('expected pending')
    expect((await service.pollLogin(8, { requestId: started.requestId })).message)
      .toBe(DREAMINA_LOGIN_MESSAGES.requestUnknown)
  })

  test('Given 已取消或窗口销毁 When 再轮询 Then 设备码已被丢弃', async () => {
    const { run } = createRunner([ok(LOGIN_MATERIAL), ok(LOGIN_MATERIAL)])
    const service = new ImageGenerationDreaminaService({ run })
    const first = await service.startLogin(7, {})
    if (first.state !== 'pending') throw new Error('expected pending')
    service.cancelLogin(7, { requestId: first.requestId })
    expect(service.activeLoginCount).toBe(0)

    const second = await service.startLogin(7, {})
    if (second.state !== 'pending') throw new Error('expected pending')
    service.releaseOwner(7)
    expect(service.activeLoginCount).toBe(0)
    expect((await service.pollLogin(7, { requestId: second.requestId })).state).toBe('failed')
  })

  test('Given 退出登录 When 成功或失败 Then 给出对应结果', async () => {
    const success = new ImageGenerationDreaminaService({ run: createRunner([ok('已清除本地登录态。\n')]).run })
    expect(await success.logout({})).toEqual({
      state: 'loggedOut',
      message: DREAMINA_LOGIN_MESSAGES.logoutSucceeded,
    })

    const failure = new ImageGenerationDreaminaService({ run: createRunner([failed('命令失败')]).run })
    expect(await failure.logout({})).toEqual({
      state: 'failed',
      message: DREAMINA_LOGIN_MESSAGES.logoutFailed,
    })
    expect((await new ImageGenerationDreaminaService({
      run: createRunner([{ exitCode: 1, stdout: '', stderr: '', failureCode: 'cliMissing' }]).run,
    }).logout({})).state).toBe('failed')
  })
})
