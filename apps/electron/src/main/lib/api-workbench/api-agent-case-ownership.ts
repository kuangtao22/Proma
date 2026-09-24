import type { ApiTestCase } from '@proma/shared'

/** Agent 保存请求时的一条用例差异，供审批卡与报告说明「模型改了什么」。 */
export interface ApiAgentCaseChange {
  caseId: string
  caseName: string
  /** 变更后的来源；新增与改动的都是 Agent。 */
  source: 'user' | 'agent'
  change: 'added' | 'updated' | 'removed'
  /** 断言条数：不做校验的用例为 0。 */
  assertionCount: number
}

/** 用例名回显；空名时退回身份，避免错误信息说不清是哪条。 */
function label(testCase: ApiTestCase): string {
  return testCase.name || testCase.id
}

/** 用户可编辑字段逐一比较；来源由 Host 决定，不参与比较。 */
function sameCase(left: ApiTestCase, right: ApiTestCase): boolean {
  return left.name === right.name
    && JSON.stringify(left.assertions) === JSON.stringify(right.assertions)
    && JSON.stringify(left.overrides ?? []) === JSON.stringify(right.overrides ?? [])
    && (left.environmentId ?? '') === (right.environmentId ?? '')
}

/** 人写用例保护与来源盖章的统一拒绝文案，模型据此可以直接改正。 */
function protectedError(testCase: ApiTestCase): Error {
  return new Error(`API_WORKBENCH_USER_CASE_PROTECTED: 用例「${label(testCase)}」由人工创建，Agent 不能修改或删除；请只新增自己的用例，或保留它原样`)
}

/**
 * 计算 Agent 保存草稿时的用例差异，并给人写的用例加保护。
 * @param previous 目录里已有的用例；新请求传 undefined。
 * @param next 本次要保存的用例集合，来源字段不可信（以 Host 记录为准）。
 * @returns 盖章后的用例（新增或改动过的记为 agent）与审批卡需要的差异列表。
 * @throws 人写用例被修改或删除时抛 API_WORKBENCH_USER_CASE_PROTECTED。
 */
export function stampApiAgentCases(
  previous: readonly ApiTestCase[] | undefined,
  next: readonly ApiTestCase[],
): { cases: ApiTestCase[]; diff: ApiAgentCaseChange[] } {
  /** 旧定义按身份索引，顺序以本次提交的用例顺序为准。 */
  const previousById = new Map((previous ?? []).map((item) => [item.id, item]))
  /** 本次提交里保留的用例身份，用于识别删除。 */
  const nextIds = new Set(next.map((item) => item.id))
  const cases: ApiTestCase[] = []
  const diff: ApiAgentCaseChange[] = []
  for (const item of next) {
    const before = previousById.get(item.id)
    if (!before) {
      /** 新身份一律记为 Agent 创建，模型自己声明的来源被忽略。 */
      cases.push({ ...item, source: 'agent' })
      diff.push({ caseId: item.id, caseName: label(item), source: 'agent', change: 'added', assertionCount: item.assertions.length })
      continue
    }
    /** 目录里的旧来源只可能是 Host 盖过的值；缺省视为人工创建。 */
    if ((before.source ?? 'user') === 'user') {
      if (!sameCase(before, item)) throw protectedError(before)
      cases.push({ ...item, source: 'user' })
      continue
    }
    cases.push({ ...item, source: 'agent' })
    if (!sameCase(before, item)) diff.push({ caseId: item.id, caseName: label(item), source: 'agent', change: 'updated', assertionCount: item.assertions.length })
  }
  for (const before of previous ?? []) {
    if (nextIds.has(before.id)) continue
    if ((before.source ?? 'user') === 'user') throw protectedError(before)
    diff.push({ caseId: before.id, caseName: label(before), source: 'agent', change: 'removed', assertionCount: before.assertions.length })
  }
  return { cases, diff }
}
