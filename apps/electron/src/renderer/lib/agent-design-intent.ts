/** 明确要求代码、组件或前端技术实现时，继续交给 Agent，不弹出 Design 选择。 */
const EXPLICIT_IMPLEMENTATION_PATTERN = /(?:修改|编写|实现|开发|编码|重构|修复|落地).{0,20}(?:代码|组件|前端|后端|html|css|javascript|typescript|react|vue|swiftui|flutter)|(?:代码|组件|前端|html|css|javascript|typescript|react|vue|swiftui|flutter).{0,20}(?:修改|编写|实现|开发|编码|重构|修复|落地)|(?:实现|开发|落地).{0,10}(?:首页|页面|界面|网站|应用)|\b(?:implement|build|code|develop|fix|refactor)\b.{0,24}\b(?:homepage|page|ui|component|website|app)\b/i

/** 只请求分析、解释或评审时不改变当前 Agent 对话流。 */
const DISCUSSION_ONLY_PATTERN = /^(?:请|帮我|麻烦)?\s*(?:分析|评审|审查|点评|解释|讨论|研究|看看|检查|为什么|怎么|如何)/i

/** 明确要求可视化产物、图片或设计稿时，应优先提供 Design 入口。 */
const VISUAL_ARTIFACT_PATTERN = /(?:效果图|设计稿|视觉稿|概念图|线框图|原型图|主视觉|海报|插画|封面|标志|图标|logo|mockup|wireframe|visual\s+design|concept\s+art|poster|illustration)/i

/** 没有实现语义的“设计 + 页面对象”属于需要用户选择的歧义请求。 */
const AMBIGUOUS_DESIGN_PATTERN = /(?:设计|重做|改版|重新设计).{0,20}(?:首页|页面|界面|落地页|登录页|仪表盘|dashboard|homepage|landing\s+page|ui|视觉|海报|logo|封面)|\bdesign\b.{0,24}\b(?:homepage|page|ui|dashboard|landing\s+page|poster|logo)\b/i

/**
 * 判断 Agent 消息是否应在发送前询问用户打开 Design。
 * @param message 用户尚未发送的纯文本要求。
 * @returns 高置信度视觉设计请求返回 true；明确实现或普通讨论返回 false。
 */
export function shouldOfferDesignHandoff(message: string): boolean {
  const normalized = message.trim()
  if (!normalized || EXPLICIT_IMPLEMENTATION_PATTERN.test(normalized)) return false
  if (DISCUSSION_ONLY_PATTERN.test(normalized)) return false
  return VISUAL_ARTIFACT_PATTERN.test(normalized) || AMBIGUOUS_DESIGN_PATTERN.test(normalized)
}
