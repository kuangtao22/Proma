/**
 * SelfBuiltModulesPage - 「自研模块」引导页
 *
 * 介绍本仓库相对上游 Proma 自己新增的四块能力：画布 / 运维工作台 / 接口工作台 / 今日活动。
 * 刻意不使用截图：上游的 `guide-*.png` 是 Proma 的界面截图，这里用卡片直接讲清每块做什么，
 * 也避免把上游品牌带进我们自己的引导流程。
 */

import * as React from 'react'
import { Blocks, Boxes, CalendarClock, ChevronLeft, ChevronRight, Network } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** 一块自研模块的展示数据。 */
interface ModuleCard {
  /** 卡片图标（直接用 lucide 的图标类型，避免自定义 props 与其不兼容）。 */
  icon: LucideIcon
  /** 中文名。 */
  name: string
  /** 英文名，与界面里的一致。 */
  english: string
  /** 一句话说明。 */
  summary: string
  /** 三条例句式的要点。 */
  points: string[]
}

/** 四块自研模块：顺序与「关于」页、README 里保持一致。 */
const MODULES: ModuleCard[] = [
  {
    icon: Network,
    name: '画布',
    english: 'Canvas',
    summary: '把任务、素材和依赖画成节点图，而不是埋在会话列表里。',
    points: ['节点即步骤、连线即依赖', '按真实层级与关联一键整理', '一张图推进多步骤交付'],
  },
  {
    icon: Boxes,
    name: '运维工作台',
    english: 'Server Ops',
    summary: 'SSH、MySQL、PostgreSQL、Redis 收进同一个面板。',
    points: ['默认只读，写操作只生成脚本', '运行诊断、表结构浏览、查询取消', '凭据本地加密，Agent 不可代取'],
  },
  {
    icon: Blocks,
    name: '接口工作台',
    english: 'API Workbench',
    summary: '把接口当成可维护的资产，而不是一次性粘贴。',
    points: ['集合 / 环境变量 / 鉴权继承', '加密与签名、multipart 附件', 'Agent 批量跑用例，逐条确认'],
  },
  {
    icon: CalendarClock,
    name: '今日活动',
    english: 'Today',
    summary: '跨项目汇总今天的全部会话，一眼看完一天做了什么。',
    points: ['按最后一次对话时间排序', '含委派子会话与定时任务', '入口在侧栏「已归档」上方'],
  },
]

/** 自研模块页的属性。 */
interface SelfBuiltModulesPageProps {
  /** 左上角章节标记，例如「进阶指南 · 第 5 步」。 */
  highlight: string
  /** 右下角主按钮文案。 */
  nextLabel: string
  /** 下一步回调。 */
  onNext: () => void
  /** 上一步回调；首页不传则不显示。 */
  onBack?: () => void
}

/**
 * 自研模块介绍页。
 */
export function SelfBuiltModulesPage({ highlight, nextLabel, onNext, onBack }: SelfBuiltModulesPageProps): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-32 md:px-10">
      <div className="m-auto w-full max-w-5xl py-10">
        <p className="mb-4 text-xs font-medium uppercase tracking-[0.2em] text-[#151515]">{highlight}</p>
        <div className="flex items-baseline gap-3">
          <h2 className="text-3xl font-light tracking-tight text-neutral-900 md:text-4xl">我们自己做的四块</h2>
          <span className="text-2xl font-light tracking-[0.3em] text-[#151515]/60 md:text-3xl">MODULES</span>
        </div>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-neutral-500">
          DutyDeck 基于 Proma 开源版演进。Chat、Agent、Skills、MCP、记忆这些能力继承自上游并持续维护；
          下面这四块是本仓库自己做的，也是它和上游最大的不同——全部本地优先，能离线的绝不联网。
        </p>

        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {MODULES.map((module) => {
            const Icon = module.icon
            return (
              <section
                key={module.name}
                className="rounded-xl border border-neutral-200/80 bg-white/70 p-6 shadow-[0_10px_24px_rgba(21,21,21,0.05)]"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#151515] text-white">
                    <Icon size={17} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-lg font-medium text-neutral-900">{module.name}</h3>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-neutral-400">{module.english}</p>
                  </div>
                </div>
                <p className="mt-4 text-[15px] leading-7 text-neutral-600">{module.summary}</p>
                <ul className="mt-4 space-y-2 border-l-2 border-[#151515]/20 pl-4">
                  {module.points.map((point) => (
                    <li key={point} className="text-sm leading-6 text-neutral-500">
                      {point}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>

        <div className="mt-12 flex w-full items-center justify-between border-t border-[#151515]/20 pt-6">
          {onBack ? (
            <button
              onClick={onBack}
              className="flex items-center gap-1 text-sm text-neutral-500 transition-colors hover:text-neutral-900"
            >
              <ChevronLeft className="h-4 w-4" />
              上一个
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={onNext}
            className="flex h-14 items-center justify-center gap-1.5 rounded-md bg-[#151515] px-9 text-base font-medium text-white shadow-[0_8px_18px_rgba(21,21,21,0.14)] transition-all hover:bg-[#2e2e2e] active:translate-y-0.5 active:shadow-none"
          >
            {nextLabel}
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
