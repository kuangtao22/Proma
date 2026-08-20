/** Windows 不允许作为文件或目录叶子的保留名称。 */
const WINDOWS_RESERVED_SLUGS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

/** manager 生成的规范 slug 语法：小写 ASCII 字母数字，以单连字符分段。 */
const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 判断持久化 slug 是否属于 workspace manager 的真实生成命名空间。 */
export function isWorkspaceSlug(slug: string): boolean {
  return WORKSPACE_SLUG_PATTERN.test(slug) && !WINDOWS_RESERVED_SLUGS.has(slug)
}

/**
 * 将工作区名称转换为 manager 使用的唯一规范 slug。
 *
 * @param name 用户输入的工作区名称。
 * @param existingSlugs 已存在的 slug 集合。
 * @param now 非 ASCII fallback 使用的当前时间戳，默认读取系统时间。
 * @returns 可安全作为跨平台单级目录叶子的唯一 slug。
 */
export function createWorkspaceSlug(
  name: string,
  existingSlugs: Set<string>,
  now: number = Date.now(),
): string {
  /** 名称归一化后的基础 slug。 */
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  if (!base) base = `workspace-${now}`
  if (WINDOWS_RESERVED_SLUGS.has(base)) base = `workspace-${base}`

  /** 追加冲突序号后的最终唯一 slug。 */
  let slug = base
  /** 从 1 开始的冲突序号。 */
  let counter = 1
  while (existingSlugs.has(slug)) {
    slug = `${base}-${counter}`
    counter++
  }
  return slug
}
