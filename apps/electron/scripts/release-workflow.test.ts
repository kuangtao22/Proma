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

interface ElectronPackageMetadata {
  /** Debian 等 Linux 安装包需要展示的项目主页。 */
  homepage?: string
}

interface ElectronBuilderConfig {
  /** Linux 安装包配置。 */
  linux?: {
    /** 避免 workspace scope 进入产物路径的稳定文件名。 */
    artifactName?: string
  }
}

/** 返回仓库中的 Release 工作流文本。 */
function readReleaseWorkflow(): string {
  /** 当前脚本到仓库根目录的相对路径。 */
  const workflowPath = resolve(import.meta.dir, '../../../.github/workflows/release.yml')
  return readFileSync(workflowPath, 'utf8')
}

/** 返回 Electron workspace 的包元数据。 */
function readElectronPackageMetadata(): ElectronPackageMetadata {
  /** 当前测试脚本到 Electron package.json 的路径。 */
  const packagePath = resolve(import.meta.dir, '../package.json')
  return JSON.parse(readFileSync(packagePath, 'utf8')) as ElectronPackageMetadata
}

/** 返回 Electron Builder 配置。 */
function readElectronBuilderConfig(): ElectronBuilderConfig {
  /** 当前测试脚本到 Electron Builder YAML 的路径。 */
  const configPath = resolve(import.meta.dir, '../electron-builder.yml')
  return Bun.YAML.parse(readFileSync(configPath, 'utf8')) as ElectronBuilderConfig
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

test('Linux deb 包含 Electron Builder 必需的项目主页', () => {
  /** Electron 安装包元数据。 */
  const metadata = readElectronPackageMetadata()
  expect(metadata.homepage).toBe('https://github.com/kuangtao22/Proma')
})

test('Linux 产物名不继承带 scope 的 workspace 包名', () => {
  /** Electron Builder 的 Linux 安装包配置。 */
  const config = readElectronBuilderConfig()
  expect(config.linux?.artifactName).toBe('Proma-${version}-${arch}.${ext}')
})
