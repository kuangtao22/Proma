import { describe, expect, test } from 'bun:test'
import { assertWeChatSendSucceeded } from './wechat-api-utils'

describe('微信 iLink 发送回执', () => {
  test.each([{}, { ret: 0 }, { errcode: 0 }, { ret: 0, errcode: 0 }])(
    'Given 成功回执 %j When 校验发送结果 Then 接受空对象或显式零状态',
    (response) => expect(() => assertWeChatSendSucceeded(response)).not.toThrow(),
  )

  test.each([{ ret: 1 }, { errcode: -1 }, { ret: 0, errcode: 40001 }])(
    'Given 失败回执 %j When 校验发送结果 Then 拒绝把失败当成已发送',
    (response) => expect(() => assertWeChatSendSucceeded(response)).toThrow('失败'),
  )

  test.each([[null], [[]], [''], [{ ret: '0' }], [{ ret: 0.5 }], [{ errcode: Infinity }]])(
    'Given 非法回执 %j When 校验发送结果 Then 拒绝无效响应且不暴露服务端错误正文',
    (response) => expect(() => assertWeChatSendSucceeded(response)).toThrow('无效'),
  )
})
