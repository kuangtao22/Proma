import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ApiScenario } from '@proma/shared'
import { ApiScenarioPanel } from './ApiScenarioPanel'
import { TooltipProvider } from '@/components/ui/tooltip'

/** 一条两步骤流程；步骤只引用请求身份，界面负责把名字补上。 */
const scenario: ApiScenario = {
  id: 'scenario_login_profile', name: '登录后看详情', description: '', collectionId: 'default', folder: '用户模块',
  steps: [
    { id: 'step_login', name: '登录', requestId: 'request_login' },
    { id: 'step_profile', name: '用户详情', requestId: 'request_profile', caseId: 'case_ok' },
  ],
  environmentId: 'env_test', onFailure: 'stop', revision: 1, updatedAt: 1,
}

/** 渲染面板；夹具里没有 preload，按钮只做展示。 */
function render(scenarios: readonly ApiScenario[], requestNames = new Map<string, string>()): string {
  return renderToStaticMarkup(
    <TooltipProvider delayDuration={0}>
      <ApiScenarioPanel sessionId="session-smoke" scenarios={scenarios} requestNames={requestNames} />
    </TooltipProvider>,
  )
}

describe('流程分区', () => {
  test('Given 没有流程 When 渲染 Then 明确说明流程定义由 Agent 维护', () => {
    const html = render([])

    expect(html).toContain('还没有流程')
    expect(html).toContain('api_save_scenario')
  })

  test('Given 已有流程 When 渲染 Then 显示模块、步骤数与失败策略并提供运行入口', () => {
    const html = render([scenario])

    expect(html).toContain('登录后看详情')
    expect(html).toContain('用户模块 · 2 步 · 失败策略 停止')
    /** 运行按钮带可定位的无障碍名称，界面 smoke 按它点击。 */
    expect(html).toContain('aria-label="运行流程 登录后看详情"')
    /** 运行前不弹确认框：确认框只在准备好步骤清单后出现。 */
    expect(html).not.toContain('确认运行')
  })

  test('Given 流程为空标题 When 渲染 Then 不虚构接口名（回退到身份）', () => {
    const html = render([{ ...scenario, folder: '' }], new Map([['request_login', '登录接口']]))

    expect(html).toContain('2 步 · 失败策略 停止')
    expect(html).not.toContain('用户模块')
  })
})
