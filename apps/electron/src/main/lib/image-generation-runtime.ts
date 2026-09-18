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
  | {
      executor: 'minimax-image'
      snapshot: Extract<ImageGenerationModelSnapshot, { executor: 'minimax-image' }>
      baseUrl: string
      apiKey: string
    }
  | {
      executor: 'dreamina-image'
      snapshot: Extract<ImageGenerationModelSnapshot, { executor: 'dreamina-image' }>
      /** CLI 路径；缺省时按 PATH 解析。即梦凭据是 CLI 登录态，没有密钥。 */
      cliPath?: string
      /** 模型的分辨率档位（1k/1.5k/2k/4k），用于校验自定义尺寸的合法范围。 */
      resolutionType?: string
    }
  | {
      executor: 'comfyui'
      snapshot: Extract<ImageGenerationModelSnapshot, { executor: 'comfyui' }>
    }

/** 单次图片工具执行前解析任务快照的主进程闭包。 */
export type ResolveImageGenerationRoute = (
  snapshot: ImageGenerationModelSnapshot,
  projectId?: string,
) => ResolvedImageGenerationRoute
