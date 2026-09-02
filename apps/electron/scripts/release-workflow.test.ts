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
  /** 当前任务提供给后续任务的输出。 */
  outputs?: Record<string, string>
}

interface ReleaseWorkflow {
  /** 工作流任务映射。 */
  jobs?: Record<string, WorkflowJob>
}

interface ElectronPackageMetadata {
  /** 当前桌面应用完整版本。 */
  version?: string
  /** Debian 等 Linux 安装包需要展示的项目主页。 */
  homepage?: string
}

interface PlatformArtifactConfig {
  /** 当前平台的安装包文件名模板。 */
  artifactName?: string
  /** 当前平台需要签名的额外二进制。 */
  binaries?: string[]
}

interface ExtraResourceConfig {
  /** 构建目录中的资源来源。 */
  from?: string
  /** 安装包 resources 下的目标目录。 */
  to?: string
}

interface ElectronBuilderConfig {
  /** 正式安装包系统标识。 */
  appId?: string
  /** 正式安装包产品名。 */
  productName?: string
  /** 是否根据预发布后缀自动改变更新频道。 */
  detectUpdateChannel?: boolean
  /** 三个平台共同携带的额外运行时资源。 */
  extraResources?: ExtraResourceConfig[]
  /** Electron Updater 使用的固定发布仓库。 */
  publish?: {
    provider?: string
    owner?: string
    repo?: string
  }
  /** macOS 安装包配置。 */
  mac?: PlatformArtifactConfig
  /** Windows 安装包配置。 */
  win?: PlatformArtifactConfig
  /** Linux 安装包配置。 */
  linux?: PlatformArtifactConfig
}

/** 返回仓库中的 Release 工作流文本。 */
function readReleaseWorkflow(): string {
  /** 当前脚本到仓库根目录的相对路径。 */
  const workflowPath = resolve(import.meta.dir, '../../../.github/workflows/release.yml')
  return readFileSync(workflowPath, 'utf8')
}

/** 返回仓库中的独立 Windows 构建工作流文本。 */
function readWindowsBuildWorkflow(): string {
  /** 当前脚本到仓库根目录的相对路径。 */
  const workflowPath = resolve(import.meta.dir, '../../../.github/workflows/build-windows.yml')
  return readFileSync(workflowPath, 'utf8')
}

/** 返回工作流任务中所有 shell 命令。 */
function workflowCommands(job: WorkflowJob | undefined): string[] {
  return job?.steps
    ?.map((step) => step.run)
    .filter((command): command is string => typeof command === 'string') ?? []
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

  expect(source.match(/^  build-linux-x64:$/gm)).toHaveLength(1)
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

test('Bone 应用版本与更新频道保持一致', () => {
  /** Electron workspace 的发布元数据。 */
  const metadata = readElectronPackageMetadata()
  /** Electron Builder 的正式打包配置。 */
  const config = readElectronBuilderConfig()
  /** 自动更新初始化源码，用于锁定预发布设置。 */
  const updaterSource = readFileSync(
    resolve(import.meta.dir, '../src/main/lib/updater/auto-updater.ts'),
    'utf8',
  )

  expect(metadata.version).toBe('0.19.16-bone.2')
  expect(config.detectUpdateChannel).toBe(false)
  expect(config.publish).toEqual({
    provider: 'github',
    owner: 'kuangtao22',
    repo: 'Proma',
  })
  expect(JSON.stringify(config.publish)).not.toContain('ErlichLiu')
  expect(updaterSource).toContain('autoUpdater.allowPrerelease = true')
})

test('正式安装包名称包含完整版本、平台和架构', () => {
  /** Electron Builder 的正式打包配置。 */
  const config = readElectronBuilderConfig()
  expect(config.appId).toBe('com.bone.proma.app')
  expect(config.productName).toBe('Proma')
  expect(config.mac?.artifactName).toBe('Proma-${version}-macos-${arch}.${ext}')
  expect(config.win?.artifactName).toBe('Proma-${version}-windows-${arch}.${ext}')
  expect(config.linux?.artifactName).toBe('Proma-${version}-linux-${arch}.${ext}')
})

test('稳定目录 helper 进入三平台资源并纳入 macOS 签名', () => {
  /** Electron Builder 的正式打包配置。 */
  const config = readElectronBuilderConfig()

  expect(config.extraResources).toEqual(expect.arrayContaining([
    expect.objectContaining({
      from: 'resources/stable-directory',
      to: 'stable-directory',
    }),
  ]))
  expect(config.mac?.binaries).toContain('resources/stable-directory/stable-directory-helper')
})

test('Windows 构建与发布在打包前执行稳定目录原生回归', () => {
  /** Windows 上必须真实运行的 helper/host 定向测试命令。 */
  const stableDirectoryTests = 'bun test apps/electron/src/main/lib/stable-directory-native-host.test.ts apps/electron/scripts/build-stable-directory-native.test.ts'
  /** 独立 Windows 构建工作流。 */
  const buildWorkflow = Bun.YAML.parse(readWindowsBuildWorkflow()) as ReleaseWorkflow
  /** 正式发布工作流。 */
  const releaseWorkflow = Bun.YAML.parse(readReleaseWorkflow()) as ReleaseWorkflow

  expect(workflowCommands(buildWorkflow.jobs?.['build-windows-x64'])).toContain(stableDirectoryTests)
  expect(workflowCommands(releaseWorkflow.jobs?.['build-windows-x64'])).toContain(stableDirectoryTests)
})

test('Release 工作流在全平台构建前校验 Bone 发布合同', () => {
  /** Release 工作流原始文本，用于验证 Release 标题和成功门禁。 */
  const source = readReleaseWorkflow()
  /** Bun YAML 解析后的 Release 工作流。 */
  const workflow = Bun.YAML.parse(source) as ReleaseWorkflow
  /** 全部需要前置校验的跨平台构建任务。 */
  const buildJobNames = [
    'build-mac-arm64',
    'build-mac-x64',
    'build-windows-x64',
    'build-linux-x64',
  ]

  expect(workflow.jobs?.['validate-release']?.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ run: 'bun run apps/electron/scripts/validate-release-version.ts' }),
  ]))
  for (const jobName of buildJobNames) {
    expect(workflow.jobs?.[jobName]?.needs).toContain('validate-release')
  }
  expect(workflow.jobs?.release?.needs).toEqual(expect.arrayContaining([
    'validate-release',
    ...buildJobNames,
  ]))
  expect(source).toContain("needs.build-linux-x64.result == 'success'")
  expect(source).toContain('--title "${RELEASE_TITLE}"')
})

test('Release 工作流使用仓库内 Bone 说明并在重跑时更新正文', () => {
  /** Release 工作流原始文本，用于校验说明文件发布合同。 */
  const source = readReleaseWorkflow()
  /** Bun YAML 解析后的 Release 工作流。 */
  const workflow = Bun.YAML.parse(source) as ReleaseWorkflow
  /** 发布前版本校验任务。 */
  const validateJob = workflow.jobs?.['validate-release']
  /** 汇总并创建 GitHub Release 的任务。 */
  const releaseJob = workflow.jobs?.release

  expect(validateJob?.outputs?.release_notes_path)
    .toBe('${{ steps.release.outputs.release_notes_path }}')
  expect(releaseJob?.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ uses: 'actions/checkout@v4' }),
  ]))
  expect(source).toContain('RELEASE_NOTES_PATH: ${{ needs.validate-release.outputs.release_notes_path }}')
  expect(source).toContain('--notes-file "${RELEASE_NOTES_PATH}"')
  expect(source).toContain('gh release edit "${TAG}"')
  expect(source).not.toContain('--generate-notes')
})

test('macOS 签名可选但不能用 step 局部环境变量误判证书状态', () => {
  /** Release 工作流原始文本，用于锁定可选签名的判断边界。 */
  const source = readReleaseWorkflow()
  /** Bun YAML 解析后的 Release 工作流。 */
  const workflow = Bun.YAML.parse(source) as ReleaseWorkflow
  /** 两个 macOS 架构构建任务。 */
  const macJobs = [
    workflow.jobs?.['build-mac-arm64'],
    workflow.jobs?.['build-mac-x64'],
  ]

  expect(source).not.toContain("if: ${{ env.MAC_CERTS != '' }}")
  for (const job of macJobs) {
    expect(job?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'mac_signing',
        env: expect.objectContaining({
          MAC_CERTS: '${{ secrets.MAC_CERTS }}',
          MAC_CERTS_PASSWORD: '${{ secrets.MAC_CERTS_PASSWORD }}',
        }),
      }),
      expect.objectContaining({
        name: '导入 macOS 签名证书',
        if: "${{ steps.mac_signing.outputs.enabled == 'true' }}",
      }),
      expect.objectContaining({
        name: expect.stringContaining('打包 (macOS'),
        env: expect.objectContaining({
          CSC_IDENTITY_AUTO_DISCOVERY: '${{ steps.mac_signing.outputs.enabled }}',
        }),
      }),
    ]))
  }
})
