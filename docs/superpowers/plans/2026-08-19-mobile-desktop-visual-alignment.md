# Proma Mobile Desktop Visual Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 LAN Bridge 认证、协议、会话和流式行为的前提下，让 `apps/mobile` 使用与 Proma 桌面端一致的语义色彩、几何、图标和状态表达，同时保留手机原生单列布局。

**Architecture:** 视觉变量只在 `apps/mobile/src/index.css` 中映射桌面默认浅色/深色语义 token，组件通过 Tailwind 语义类消费，不导入桌面 Renderer CSS。组件改动限定为展示层与可访问名称；状态继续由既有 Jotai atoms 和 WebSocket 流程驱动，以静态主题契约测试、SSR 组件测试和现有行为测试锁定边界。

**Tech Stack:** Bun、TypeScript、React 18、Jotai、Vite、Tailwind CSS 3、Lucide React 0.460、Bun Test、React DOM Server

---

## 文件结构与职责

- `apps/mobile/package.json`：声明手机端直接使用的 `lucide-react` 依赖，不改变应用版本。
- `bun.lock`：由 Bun 更新移动 workspace 的现有 Lucide 依赖归属。
- `apps/mobile/tailwind.config.js`：把新增语义变量暴露为 Tailwind 颜色与阴影工具。
- `apps/mobile/src/index.css`：唯一的跨端主题映射层，包含浅色、系统深色、基础排版、Markdown 与动效降级。
- `apps/mobile/src/index.test.ts`：静态验证浅色/深色变量、系统主题媒体查询和硬编码颜色禁令。
- `apps/mobile/src/components/layout/AuthPage.tsx`：连接页的品牌层级、扫码状态、手工回退表单和错误状态。
- `apps/mobile/src/components/layout/AuthPage.test.tsx`：锁定连接页可访问字段、扫码等待/错误和按钮禁用状态。
- `apps/mobile/src/components/layout/AppShell.tsx`：48px 顶栏、连接状态、菜单和会话切换入口。
- `apps/mobile/src/components/layout/Drawer.tsx`：桌面侧栏语义表面、分段控件、工作区筛选、会话列表和底部动作。
- `apps/mobile/src/components/layout/Drawer.test.tsx`：锁定抽屉动作名称、空态和无 emoji 图标契约。
- `apps/mobile/src/components/conversation/ConvDropdown.tsx`：会话切换弹层表面、行密度和 Lucide 状态图标。
- `apps/mobile/src/components/conversation/ChatView.tsx`：消息区域表面、空态、流式消息和输入区边界。
- `apps/mobile/src/components/conversation/MessageBubble.tsx`：AI 无大气泡排版、用户强调表面、思考区域和元信息。
- `apps/mobile/src/components/conversation/ToolUseBlock.tsx`：工具图标、展开状态和成功/失败语义。
- `apps/mobile/src/components/conversation/MessageBubble.test.tsx`：锁定 AI/用户/思考/工具四类消息结构与窄屏换行类。
- `apps/mobile/src/components/conversation/InputBar.tsx`：桌面 ChatInput 的移动布局、固定发送/停止控件和底部模型弹层。
- `apps/mobile/src/components/conversation/InputBar.test.tsx`：锁定输入禁用、按钮可访问名称、模型搜索/空态和权限模式。
- `MEMORY.md`：记录手机主题作为 fork 内部映射层、跟随系统明暗且不扩展协议的长期决策。

### Task 1: 建立手机端主题契约和 Lucide 依赖

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`
- Modify: `apps/mobile/tailwind.config.js`
- Modify: `apps/mobile/src/index.css`
- Create: `apps/mobile/src/index.test.ts`

- [ ] **Step 1: 写入会失败的主题契约测试**

```ts
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 手机端全局样式文本，用于锁定与桌面一致的语义主题边界。 */
const stylesheet = readFileSync(join(import.meta.dir, 'index.css'), 'utf8')

describe('移动端主题契约', () => {
  test('Given 默认主题 When 读取样式 Then 提供完整浅色语义表面', () => {
    for (const token of [
      '--background:', '--foreground:', '--content-area:', '--sidebar-surface:',
      '--sidebar-control-surface:', '--input-surface:', '--card:', '--popover:',
      '--destructive:', '--radius: 0.375rem;',
    ]) expect(stylesheet).toContain(token)
    expect(stylesheet).toContain('color-scheme: light dark')
  })

  test('Given 系统深色 When 媒体查询生效 Then 覆盖核心语义表面', () => {
    const darkTheme = stylesheet.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    for (const token of ['--background:', '--content-area:', '--sidebar-surface:', '--input-surface:', '--popover:']) {
      expect(darkTheme).toContain(token)
    }
  })
})
```

- [ ] **Step 2: 运行测试并确认缺少浅色/深色语义层**

Run: `bun test apps/mobile/src/index.test.ts`

Expected: FAIL，指出 `--content-area`、`--sidebar-surface`、`@media (prefers-color-scheme: dark)` 等契约缺失。

- [ ] **Step 3: 声明现有 Lucide 版本并更新锁文件**

在 `apps/mobile/package.json` 的 `dependencies` 中增加：

```json
"lucide-react": "^0.460.0"
```

Run: `bun install`

Expected: `bun.lock` 只增加 `@proma/mobile` 对既有 `lucide-react@0.460.0` 的 workspace 依赖引用，不引入第二个版本。

- [ ] **Step 4: 增加手机端主题映射与 Tailwind 语义工具**

在 `apps/mobile/src/index.css` 中用桌面默认主题值替换硬编码深色根变量；浅色放在 `:root`，深色只放在媒体查询中：

```css
:root {
  color-scheme: light dark;
  --background: 0 0% 100%;
  --foreground: 0 0% 3.9%;
  --muted: 0 0% 96.1%;
  --muted-foreground: 0 0% 45.1%;
  --primary: 0 0% 9%;
  --primary-foreground: 0 0% 98%;
  --secondary: 0 0% 96.1%;
  --secondary-foreground: 0 0% 9%;
  --accent: 0 0% 96.1%;
  --accent-foreground: 0 0% 9%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 0 0% 98%;
  --border: 0 0% 89.8%;
  --input: 0 0% 89.8%;
  --ring: 0 0% 3.9%;
  --card: 0 0% 100%;
  --card-foreground: 0 0% 3.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 0 0% 3.9%;
  --content-area: 0 0% 100%;
  --sidebar-surface: 60 14.3% 98.6%;
  --sidebar-control-surface: 60 7% 93%;
  --sidebar-control-surface-hover: 60 7% 90%;
  --input-surface: 60 14.3% 98.6%;
  --radius: 0.375rem;
  --safe-b: env(safe-area-inset-bottom, 0px);
  --safe-t: env(safe-area-inset-top, 0px);
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: 0 0% 10%;
    --foreground: 0 0% 98%;
    --muted: 0 0% 17%;
    --muted-foreground: 0 0% 63.9%;
    --primary: 0 0% 98%;
    --primary-foreground: 0 0% 9%;
    --secondary: 0 0% 17%;
    --secondary-foreground: 0 0% 98%;
    --accent: 0 0% 40%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 55% 45%;
    --destructive-foreground: 0 0% 98%;
    --border: 0 0% 22%;
    --input: 0 0% 22%;
    --ring: 0 0% 83.1%;
    --card: 0 0% 13%;
    --card-foreground: 0 0% 98%;
    --popover: 0 0% 14%;
    --popover-foreground: 0 0% 98%;
    --content-area: 0 0% 7%;
    --sidebar-surface: 0 0% 10%;
    --sidebar-control-surface: 0 0% 17%;
    --sidebar-control-surface-hover: 0 0% 21%;
    --input-surface: 0 0% 9%;
  }
}
```

同时为 `body` 设置桌面式系统字体栈、`background`/`color`，为 Markdown 增加浅色默认与深色覆盖，并在 `prefers-reduced-motion: reduce` 下关闭非必要过渡。

在 `apps/mobile/tailwind.config.js` 的 `extend.colors` 中增加：

```js
destructive: {
  DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
  foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
},
card: {
  DEFAULT: 'hsl(var(--card) / <alpha-value>)',
  foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
},
popover: {
  DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
  foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
},
content: 'hsl(var(--content-area) / <alpha-value>)',
sidebar: 'hsl(var(--sidebar-surface) / <alpha-value>)',
'sidebar-control': 'hsl(var(--sidebar-control-surface) / <alpha-value>)',
'input-surface': 'hsl(var(--input-surface) / <alpha-value>)',
```

- [ ] **Step 5: 运行主题契约、类型检查和构建**

Run: `bun test apps/mobile/src/index.test.ts`

Expected: PASS，`2 pass`。

Run: `bun run --filter='@proma/mobile' typecheck`

Expected: PASS，退出码 0。

Run: `bun run --filter='@proma/mobile' build`

Expected: PASS，Vite 生成 `apps/mobile/dist`，无缺失 Lucide 模块。

### Task 2: 重构连接页、顶栏和会话切换层

**Files:**
- Modify: `apps/mobile/src/components/layout/AuthPage.test.tsx`
- Modify: `apps/mobile/src/components/layout/AuthPage.tsx`
- Modify: `apps/mobile/src/components/layout/AppShell.tsx`
- Modify: `apps/mobile/src/components/conversation/ConvDropdown.tsx`

- [ ] **Step 1: 扩展连接页状态测试**

在 `AuthPage.test.tsx` 增加：

```tsx
test('Given 扫码等待或失败 When 渲染连接页 Then 状态可被读屏识别且手工回退始终存在', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { AuthPage } = await import('./AuthPage')
  /** 同时提供等待与错误，验证二者不会遮蔽手工回退字段。 */
  const markup = renderToStaticMarkup(
    <AuthPage
      deviceId="mobile-device-1"
      onSuccess={() => undefined}
      pairingPending
      pairingError="二维码已失效"
    />,
  )

  expect(markup).toContain('role="status"')
  expect(markup).toContain('role="alert"')
  expect(markup).toContain('正在验证扫码连接')
  expect(markup).toContain('二维码已失效')
  expect(markup).toContain('id="auth-pin"')
  expect(markup).toContain('aria-label="连接到桌面 Proma"')
})
```

- [ ] **Step 2: 运行测试并确认缺少新的可访问名称**

Run: `bun test apps/mobile/src/components/layout/AuthPage.test.tsx`

Expected: FAIL，指出连接按钮缺少 `aria-label="连接到桌面 Proma"`。

- [ ] **Step 3: 实现安静的连接页和桌面式顶栏**

`AuthPage.tsx` 保留 `handleSubmit`、字段 id、PIN 过滤、扫码状态和回调不变，只调整结构和类名：

```tsx
<main className="min-h-full overflow-y-auto bg-content px-5 text-foreground" style={{ paddingTop: 'max(var(--safe-t), 24px)', paddingBottom: 'max(var(--safe-b), 24px)' }}>
  <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center py-8">
    <header className="mb-8">
      <h1 className="text-[28px] font-semibold leading-tight">Proma</h1>
      <p className="mt-1 text-sm text-muted-foreground">连接桌面端，继续当前工作</p>
    </header>
    {/* 现有扫码状态和 form 原样保留，仅改用 rounded-md、bg-input-surface 与 destructive。 */}
    <button aria-label="连接到桌面 Proma" type="submit" disabled={loading || pairingPending}>
      {loading ? '连接中…' : '连接'}
    </button>
  </div>
</main>
```

`AppShell.tsx` 使用 `Menu`、`ChevronDown` 替换内联 SVG；顶栏固定 `h-12`，菜单按钮为 `h-10 w-10`，标题保持 `truncate`，并在标题下显示 `已连接` 次级状态。每个图标按钮增加 `aria-label`，不改变 `handleOpenDrawer`、`handleToggleDropdown` 或刷新行为。

`ConvDropdown.tsx` 将硬编码 `bg-[#141416]` 替换为 `bg-popover text-popover-foreground`，圆角改为 `rounded-b-md`；使用 `Check`、`Plus`、`PanelLeftOpen`，保留 `handleSwitch`、`handleCreate`、`handleViewAll` 的现有数据流。

- [ ] **Step 4: 运行连接页测试、移动端类型检查**

Run: `bun test apps/mobile/src/components/layout/AuthPage.test.tsx`

Expected: PASS，`3 pass`。

Run: `bun run --filter='@proma/mobile' typecheck`

Expected: PASS，退出码 0。

### Task 3: 重构抽屉并锁定触控与空态契约

**Files:**
- Create: `apps/mobile/src/components/layout/Drawer.test.tsx`
- Modify: `apps/mobile/src/components/layout/Drawer.tsx`

- [ ] **Step 1: 写入抽屉展示契约测试**

```tsx
import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'

/** 提供移动端 atoms 初始化所需的最小浏览器环境。 */
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => null },
})
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { location: { hostname: '127.0.0.1' } },
})

describe('移动端会话抽屉', () => {
  test('Given 空会话列表 When 渲染 Agent 抽屉 Then 展示可访问动作和真实空态', async () => {
    const {
      activeTabAtom, conversationsAtom, currentWorkspaceIdAtom, tokenAtom, workspacesAtom,
    } = await import('../../atoms')
    const { Drawer } = await import('./Drawer')
    /** 独立 store 防止测试污染应用全局 atoms。 */
    const store = createStore()
    store.set(tokenAtom, 'token')
    store.set(activeTabAtom, 'agent')
    store.set(conversationsAtom, [])
    store.set(workspacesAtom, [])
    store.set(currentWorkspaceIdAtom, null)
    const markup = renderToStaticMarkup(
      <Provider store={store}><Drawer onClose={() => undefined} /></Provider>,
    )

    expect(markup).toContain('aria-label="关闭会话抽屉"')
    expect(markup).toContain('新建对话')
    expect(markup).toContain('暂无 Agent 对话')
    expect(markup).toContain('刷新')
    expect(markup).toContain('断开')
    expect(markup).not.toMatch(/[📌●]/u)
  })
})
```

- [ ] **Step 2: 运行测试并确认内联图标契约失败**

Run: `bun test apps/mobile/src/components/layout/Drawer.test.tsx`

Expected: FAIL，指出关闭按钮缺少 `aria-label`。

- [ ] **Step 3: 用语义表面和 Lucide 图标实现抽屉**

在 `Drawer.tsx` 导入 `CheckCircle2`、`LogOut`、`Pin`、`Plus`、`RefreshCw`、`X`。根节点改为：

```tsx
<nav aria-label="会话抽屉" className="flex h-full w-72 max-w-[84vw] flex-col border-r border-border bg-sidebar text-foreground shadow-xl">
```

实现时满足以下不变式：

- 关闭按钮 `aria-label="关闭会话抽屉"`，固定 `h-10 w-10`。
- Agent/Chat 使用 `rounded-md bg-sidebar-control p-1` 的紧凑分段控件，选中项使用 `bg-content`。
- 工作区筛选保持横向滚动，不截断最后一项。
- 新建、刷新、断开使用 Lucide 图标；置顶和工作中分别使用 `Pin`、`CheckCircle2`，不再输出 emoji。
- 会话行最小高度 40px；标题 `truncate`，时间 `shrink-0`。
- 继续调用现有 `handleOpen`、`handleCreate`、`handleRefresh`、`handleDisconnect`，不修改认证清理顺序。

- [ ] **Step 4: 运行抽屉测试和既有认证恢复测试**

Run: `bun test apps/mobile/src/components/layout/Drawer.test.tsx apps/mobile/src/lib/auth-recovery.test.ts apps/mobile/src/lib/device-credentials.test.ts`

Expected: PASS，抽屉展示契约和可信设备认证行为全部通过。

### Task 4: 统一消息、思考和工具调用视觉

**Files:**
- Create: `apps/mobile/src/components/conversation/MessageBubble.test.tsx`
- Modify: `apps/mobile/src/components/conversation/MessageBubble.tsx`
- Modify: `apps/mobile/src/components/conversation/ToolUseBlock.tsx`
- Modify: `apps/mobile/src/components/conversation/ChatView.tsx`

- [ ] **Step 1: 写入四类消息的 BDD 渲染测试**

```tsx
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Message, ToolResultContent } from '../../atoms'
import { MessageBubble } from './MessageBubble'

/** 用空结果映射渲染不含工具结果的普通消息。 */
const emptyResults = new Map<string, ToolResultContent>()

describe('移动端消息视觉结构', () => {
  test('Given AI 正文和用户正文 When 渲染 Then AI 平铺且用户使用克制强调表面', () => {
    const assistant: Message = { id: 'a', role: 'assistant', content: '回答', model: 'gpt-test' }
    const user: Message = { id: 'u', role: 'user', content: '问题' }
    const assistantMarkup = renderToStaticMarkup(<MessageBubble message={assistant} resultMap={emptyResults} />)
    const userMarkup = renderToStaticMarkup(<MessageBubble message={user} resultMap={emptyResults} />)

    expect(assistantMarkup).toContain('data-message-role="assistant"')
    expect(assistantMarkup).toContain('break-words')
    expect(assistantMarkup).not.toContain('bg-gradient-to-br')
    expect(userMarkup).toContain('data-message-role="user"')
    expect(userMarkup).toContain('bg-secondary')
  })

  test('Given 思考和工具调用 When 渲染 Then 使用文字状态与可折叠次级区域', () => {
    const message: Message = {
      id: 'tool', role: 'assistant',
      content: [
        { type: 'thinking', thinking: '分析过程' },
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      ],
    }
    const markup = renderToStaticMarkup(<MessageBubble message={message} resultMap={emptyResults} />)

    expect(markup).toContain('思考过程')
    expect(markup).toContain('读取文件 a.ts')
    expect(markup).not.toMatch(/[🧠📄]/u)
  })
})
```

- [ ] **Step 2: 运行测试并确认渐变头像、emoji 与消息结构不满足契约**

Run: `bun test apps/mobile/src/components/conversation/MessageBubble.test.tsx`

Expected: FAIL，指出缺少 `data-message-role`、存在渐变/emoji 或用户表面不是 `bg-secondary`。

- [ ] **Step 3: 实现桌面式消息和工具块**

`MessageBubble.tsx` 引入 `Bot`、`Brain`、`UserRound`，并统一使用两个展示分支：

```tsx
<article data-message-role="assistant" className="flex min-w-0 gap-2.5">
  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card">
    <Bot aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
  </div>
  <div className="min-w-0 flex-1">
    <div className="prose prose-sm max-w-none break-words [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />
  </div>
</article>

<article data-message-role="user" className="flex min-w-0 flex-row-reverse gap-2.5">
  <div className="min-w-0 rounded-md bg-secondary px-3 py-2 text-secondary-foreground" style={{ maxWidth: 'calc(100% - 38px)' }}>
    <div className="prose prose-sm max-w-none break-words [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />
  </div>
</article>
```

AI 正文不再加大块 `bg-muted` 气泡；思考区域使用 `details`、`Brain`、`border-border` 和 `bg-muted/50`；所有 Markdown 容器加入 `break-words [overflow-wrap:anywhere]`，代码块保留自身横向滚动。

`ToolUseBlock.tsx` 删除 `TOOL_ICONS` emoji 映射，新增 `getToolIcon(name)`，返回 `FileText`、`Pencil`、`Terminal`、`Search`、`FolderSearch`、`Globe2`、`Bot` 或 `Wrench`；成功/失败使用 `Check`、`X` 和 `text-destructive`。新增函数配套中文注释，现有 `getToolSummary` 与 500 字符截断保持不变。

`ChatView.tsx` 使用 `bg-content`，在消息为空且不流式时展示 `开始一段新对话` 空态；流式消息复用与历史 AI 消息相同的头像、元信息和正文结构，不更改 `onPush`、generation、订阅或自动滚动逻辑。

- [ ] **Step 4: 运行消息测试和会话恢复测试**

Run: `bun test apps/mobile/src/components/conversation/MessageBubble.test.tsx apps/mobile/src/lib/recovery-guards.test.ts`

Expected: PASS，消息视觉契约通过，历史加载与流式恢复保护仍全部通过。

### Task 5: 重构输入区和底部模型选择器

**Files:**
- Create: `apps/mobile/src/components/conversation/InputBar.test.tsx`
- Modify: `apps/mobile/src/components/conversation/InputBar.tsx`

- [ ] **Step 1: 写入输入区和模型选择器测试**

将 `ModelPicker` 作为具名导出，便于不操作内部 React 状态即可测试内容契约：

```tsx
import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'

/** 提供移动端 atoms 初始化所需的最小浏览器环境。 */
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => null },
})
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { location: { hostname: '127.0.0.1' } },
})

describe('移动端输入区', () => {
  test('Given 输入区禁用 When 渲染 Then 输入和发送控制具有稳定名称与禁用状态', async () => {
    const { activeConvAtom, channelsAtom, streamingAtom } = await import('../../atoms')
    const { InputBar } = await import('./InputBar')
    /** 独立 store 提供输入区渲染所需的最小会话状态。 */
    const store = createStore()
    store.set(activeConvAtom, { id: 'conv-1', title: '测试', type: 'agent', updatedAt: 1 })
    store.set(streamingAtom, false)
    store.set(channelsAtom, [])
    const markup = renderToStaticMarkup(<Provider store={store}><InputBar disabled /></Provider>)

    expect(markup).toContain('aria-label="消息输入"')
    expect(markup).toContain('aria-label="选择模型"')
    expect(markup).toContain('aria-label="发送消息"')
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
    expect(markup).toMatch(/<button[^>]*aria-label="发送消息"[^>]*disabled=""/)
  })

  test('Given 没有匹配模型 When 渲染模型选择器 Then 展示搜索与真实空态', async () => {
    const { ModelPicker } = await import('./InputBar')
    const markup = renderToStaticMarkup(
      <ModelPicker channelId={null} modelId={null} channels={[]} onSelect={() => undefined} />,
    )
    expect(markup).toContain('aria-label="搜索模型"')
    expect(markup).toContain('未找到模型')
  })
})
```

- [ ] **Step 2: 运行测试并确认可访问名称和导出缺失**

Run: `bun test apps/mobile/src/components/conversation/InputBar.test.tsx`

Expected: FAIL，指出 `ModelPicker` 未导出或输入/按钮缺少可访问名称。

- [ ] **Step 3: 实现稳定输入容器和底部弹层**

在 `InputBar.tsx` 中：

- 导入 `Check`、`ChevronDown`、`Compass`、`Map`、`Search`、`Send`、`Square`、`Zap`。
- 把 `catch (e: any)` 改为 `catch (_error: unknown)`，不新增错误状态或改变发送失败行为。
- 输入容器改为 `rounded-lg border bg-input-surface shadow-sm`，工具栏和按钮保持固定高度。
- textarea 增加 `aria-label="消息输入"`；模型、权限、发送、停止按钮分别增加稳定 `aria-label`。
- 发送/停止按钮固定 `h-9 w-9 rounded-md`，发送图标用 `Send`，停止图标用 `Square`。
- 模型选择器采用 `fixed inset-x-0 bottom-0` 的底部弹层，最大高度 `min(70dvh, 560px)`，底部 padding 包含 `var(--safe-b)`；背景使用 `bg-popover`，圆角只在顶部使用 `rounded-t-lg`。
- `ModelPicker` 改为具名导出，搜索输入使用 `Search` 和 `aria-label="搜索模型"`，选中项使用 `Check`；渠道和模型筛选算法不变。
- `ModeIcon` 用 `Compass`、`Zap`、`Map`，权限循环顺序保持 `PERMISSION_MODE_ORDER`。

- [ ] **Step 4: 运行输入区、消息和类型检查**

Run: `bun test apps/mobile/src/components/conversation/InputBar.test.tsx apps/mobile/src/components/conversation/MessageBubble.test.tsx`

Expected: PASS，`4 pass`。

Run: `bun run --filter='@proma/mobile' typecheck`

Expected: PASS，退出码 0，且 `InputBar.tsx` 不再包含显式 `any`。

### Task 6: 全量回归、视觉验收和长期决策记录

**Files:**
- Modify: `MEMORY.md`
- Verify only: `apps/mobile/dist/**`

- [ ] **Step 1: 运行移动端完整测试**

Run: `bun test apps/mobile/src`

Expected: PASS；既有配对票据、可信设备恢复、WebSocket 重连、会话 generation 测试和新增视觉契约全部通过。

- [ ] **Step 2: 运行移动端类型检查和生产构建**

Run: `bun run --filter='@proma/mobile' typecheck`

Expected: PASS，退出码 0。

Run: `bun run --filter='@proma/mobile' build`

Expected: PASS，Vite 生产构建完成且无硬编码深色模块或缺失图标依赖。

- [ ] **Step 3: 运行关联工作区验证**

Run: `bun run typecheck`

Expected: PASS，所有 workspace typecheck 退出码均为 0。

Run: `bun run --filter='@proma/electron' check:fork-compat`

Expected: PASS，移动端入口、协议能力与 fork 接缝检查全部通过。

- [ ] **Step 4: 启动实际项目并验证 LAN Bridge 提供最新构建**

Run: `bun run dev`

Expected: Electron Renderer 启动，LAN Bridge 监听 `*:29888`。

Run: `curl -I http://127.0.0.1:29888/`

Expected: HTTP 200，响应来自新构建的 `apps/mobile/dist`。

- [ ] **Step 5: 完成手机视口明暗主题视觉检查**

使用真实 LAN 页面分别模拟 `light` 和 `dark`，检查 `390x844`、`375x667`、`320x568`：

- 连接页：品牌、扫码等待、扫码失败、PIN 表单和禁用按钮无重叠。
- 抽屉：分段控件、工作区横向滚动、会话长标题、空态和底部动作可见。
- 聊天：AI 正文、用户消息、思考、工具结果、流式状态、空态和 Markdown 长内容不撑破页面。
- 输入：键盘前底部安全区、长模型名、权限按钮、发送/停止固定尺寸。
- 模型弹层：搜索、渠道分组、选中态、空结果和内部滚动可用。
- 页面无横向滚动、文字裁切、控件遮挡和明暗主题低对比问题。

- [ ] **Step 6: 记录低耦合主题决策并检查最终差异**

在 `MEMORY.md` 的“架构决策”增加：

```markdown
- 手机端视觉与桌面端共享语义设计语言，但主题映射保留在 `apps/mobile` 内；默认通过 `prefers-color-scheme` 跟随系统明暗，不导入桌面 Renderer CSS，也不扩展 LAN 协议或持久化字段。
```

Run: `git diff --check`

Expected: PASS，无尾随空格或补丁格式错误。

Run: `git status --short`

Expected: 只包含用户已有 LAN 可信设备改动、本计划列出的移动端视觉文件、设计规格与计划文档；不包含 README、release notes、协议、IPC 或桌面业务组件的新改动。

## 实施边界

- 不提交、不推送、不打安装包；这些操作需要用户单独授权。
- 不修改 `packages/shared`、LAN Bridge 主进程、IPC、Preload 或桌面 Renderer 业务组件。
- 不增加主题 React state、localStorage、WebSocket 消息或图片/字体资源。
- 不改变扫码免 PIN、可信设备续签、撤销、会话加载、消息推送、模型选择和权限模式的数据契约。
- 所有新增函数和非显然变量配套中文注释；不引入 `any`。
