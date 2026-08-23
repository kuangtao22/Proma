import type { AgentToolResultImage, ImportAgentImageInput } from '@proma/shared'

/** Agent 工具图片导入动作所需的最小主进程能力。 */
export interface AgentDesignActionDependencies {
  importImage: (input: ImportAgentImageInput) => Promise<unknown>
}

/** 一次“加入设计”动作的可信上下文。 */
export interface ImportAgentToolResultImagesInput {
  projectId: string
  sessionId: string
  images: AgentToolResultImage[]
}

/**
 * 将当前会话工具结果中的图片逐张加入项目设计，不切页也不发送 Agent 消息。
 * @param input 主进程仍会重新验证的项目、会话和精确图片路径。
 * @param dependencies 仅暴露 Design 图片导入能力。
 * @returns 成功导入的图片数量。
 */
export async function importAgentToolResultImagesToDesign(
  input: ImportAgentToolResultImagesInput,
  dependencies: AgentDesignActionDependencies,
): Promise<number> {
  for (const [index, image] of input.images.entries()) {
    /** 多图使用固定级联偏移，避免导入后完全重叠。 */
    const offset = 40 + index * 24
    await dependencies.importImage({
      projectId: input.projectId,
      sessionId: input.sessionId,
      localPath: image.localPath,
      position: { x: offset, y: offset },
    })
  }
  return input.images.length
}
