/** WebView 未填写内容时的离线骨架；创建与证据读取共用，避免把默认 HTML 当作成果。 */
export const EMPTY_WEBVIEW_HTML = '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>未命名原型</title>\n</head>\n<body></body>\n</html>\n'

/** 仅消除默认骨架的排版空白，比较时不解析或执行用户 HTML。 */
const EMPTY_WEBVIEW_COMPACT_HTML = EMPTY_WEBVIEW_HTML.replace(/\s+/g, '')

/**
 * 判断可信读取的正文是否已脱离空占位；不代表专业内容或交互质量通过。
 * @param kind 文档或原型类型。
 * @param content 由受管文本服务精确读取的完整正文。
 * @returns 正文非空且不是默认空原型时返回 true，与 revision 是否为零无关。
 */
export function hasCanvasTextArtifactContent(kind: 'document' | 'webview', content: string): boolean {
  if (!content.trim()) return false
  return kind === 'document' || content.replace(/\s+/g, '') !== EMPTY_WEBVIEW_COMPACT_HTML
}
