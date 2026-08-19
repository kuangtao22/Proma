import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface WorkflowJob {
  /** GitHub Runner 标签。 */
  'runs-on'?: string
  /** 当前任务依赖的其他任务。 */
  needs?: string[]
  /** 当前任务的执行步骤。 */
  steps?: Array<Record<string, unknown>>
}

interface ReleaseWorkflow {
  /** 工作流任务映射。 */
  jobs?: Record<string, WorkflowJob>
}

/** 返回仓库中的 Release 工作流文本。 */
function readReleaseWorkflow(): string {
  /** 当前脚本到仓库根目录的相对路径。 */
  const workflowPath = resolve(import.meta.dir, '../../../.github/workflows/release.yml')
  return readFileSync(workflowPath, 'utf8')
}

test('Release 工作流构建并发布 Linux x64 安装包', () => {
  /** Release 工作流原始文本，用于验证产物筛选规则。 */
  const source = readReleaseWorkflow()
  /** Bun YAML 解析后的 Release 工作流。 */
  const workflow = Bun.YAML.parse(source) as ReleaseWorkflow
  /** Linux x64 构建任务。 */
  const linuxJob = workflow.jobs?.['build-linux-x64']
  /** 汇总并创建 GitHub Release 的任务。 */
  const releaseJob = workflow.jobs?.release

  expect(linuxJob?.['runs-on']).toBe('ubuntu-latest')
  expect(linuxJob?.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({
      uses: 'actions/upload-artifact@v4',
      with: expect.objectContaining({ name: 'linux-x64' }),
    }),
  ]))
  expect(releaseJob?.needs).toContain('build-linux-x64')
  expect(releaseJob?.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({
      uses: 'actions/download-artifact@v4',
      with: expect.objectContaining({ name: 'linux-x64', path: 'out/linux-x64' }),
    }),
  ]))
  expect(source).toContain("-name '*.AppImage'")
  expect(source).toContain("-name '*.deb'")
  expect(source).toContain("-name 'latest-linux.yml'")
})
