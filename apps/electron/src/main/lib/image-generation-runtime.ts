import type { ImageGenerationModelSnapshot } from '@proma/shared'

/** 已完成实时校验、只允许在主进程本轮调用内存在的生图路由。 */
export type ResolvedImageGenerationRoute =
  | {
      executor: 'nano-banana'
      snapshot: Extract<ImageGenerationModelSnapshot, { executor: 'nano-banana' }>
    }
  | {
      executor: 'openai-images'
      snapshot: Extract<ImageGenerationModelSnapshot, { executor: 'openai-images' }>
      baseUrl: string
      apiKey: string
    }

/** 单次图片工具执行前解析任务快照的主进程闭包。 */
export type ResolveImageGenerationRoute = (
  snapshot: ImageGenerationModelSnapshot,
) => ResolvedImageGenerationRoute
