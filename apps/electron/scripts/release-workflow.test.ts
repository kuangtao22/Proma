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
  /** Electron workspace 的构建与发布脚本。 */
  scripts?: Record<string, string>
  /** Electron workspace 的开发期依赖。 */
  devDependencies?: Record<string, string>
}

interface RootPackageMetadata {
  /** 仓库统一使用的 Bun 包管理器版本。 */
  packageManager?: string
  /** monorepo 构建期共享依赖。 */
  devDependencies?: Record<string, string>
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
  /** Windows NSIS 安装器配置。 */
  nsis?: {
    /** 注入 electron-builder NSIS 模板的自定义 include。 */
    include?: string
  }
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

/** 返回 monorepo 根包元数据。 */
function readRootPackageMetadata(): RootPackageMetadata {
  /** 当前测试脚本到根 package.json 的路径。 */
  const packagePath = resolve(import.meta.dir, '../../../package.json')
  return JSON.parse(readFileSync(packagePath, 'utf8')) as RootPackageMetadata
}

/** 返回 Electron Builder 配置。 */
function readElectronBuilderConfig(): ElectronBuilderConfig {
  /** 当前测试脚本到 Electron Builder YAML 的路径。 */
  const configPath = resolve(import.meta.dir, '../electron-builder.yml')
  return Bun.YAML.parse(readFileSync(configPath, 'utf8')) as ElectronBuilderConfig
}

/** 返回 Windows 安装器自定义 NSIS include 文本。 */
function readWindowsInstallerInclude(): string {
  /** 当前测试脚本到 NSIS include 的路径。 */
  const includePath = resolve(import.meta.dir, '../resources/installer.nsh')
  return readFileSync(includePath, 'utf8')
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

test('打包准备在清理运行时依赖目录前重建 node-pty', () => {
  /** Electron workspace 的打包准备命令。 */
  const packagePrepare = readElectronPackageMetadata().scripts?.['package:prepare']

  expect(packagePrepare).toBe(
    'bun run build && bun run build:mobile && bun run rebuild:node-pty && bun run sync:runtime-deps',
  )
})

test('Windows 打包先安装并校验 win32-x64 Sharp 运行时依赖', () => {
  /** Electron workspace 的 Windows 专用资源准备命令。 */
  const packagePrepareWindows = readElectronPackageMetadata().scripts?.['package:prepare:win']
  /** Electron workspace 的 Windows 本地打包入口。 */
  const distWindows = readElectronPackageMetadata().scripts?.['dist:win']
  /** Windows 目标依赖安装命令。 */
  const installWindowsDependencies = 'bun install --frozen-lockfile --os=win32 --cpu=x64'
  /** Windows 目标依赖同步与合同校验命令。 */
  const syncWindowsDependencies = 'bun run sync:runtime-deps --target-platform=win32 --target-arch=x64'

  expect(packagePrepareWindows).toContain(installWindowsDependencies)
  expect(packagePrepareWindows).toContain(syncWindowsDependencies)
  expect(packagePrepareWindows?.indexOf(installWindowsDependencies))
    .toBeLessThan(packagePrepareWindows?.indexOf(syncWindowsDependencies) ?? -1)
  expect(distWindows).toBe('bun run package:prepare:win && bun run builder --win')

  for (const source of [readReleaseWorkflow(), readWindowsBuildWorkflow()]) {
    /** 当前工作流 Windows job 的全部 shell 命令。 */
    const commands = workflowCommands((Bun.YAML.parse(source) as ReleaseWorkflow).jobs?.['build-windows-x64'])
    expect(commands).toContain("bun run --filter='@proma/electron' package:prepare:win")
    expect(commands).not.toContain("bun run --filter='@proma/electron' package:prepare")
  }
})

test('所有打包入口使用固定版本的 Electron Builder', () => {
  /** Electron workspace 的包元数据。 */
  const metadata = readElectronPackageMetadata()
  /** Release 工作流原始文本。 */
  const releaseWorkflow = readReleaseWorkflow()
  /** 独立 Windows 构建工作流原始文本。 */
  const windowsWorkflow = readWindowsBuildWorkflow()
  /** 可视化打包脚本源码。 */
  const distSource = readFileSync(resolve(import.meta.dir, './dist.ts'), 'utf8')
  /** 允许调用统一固定版本打包器的发布脚本。 */
  const packagingScripts = ['pack', 'dist', 'dist:mac', 'dist:win', 'dist:linux']

  expect(metadata.devDependencies?.['electron-builder']).toBe('25.1.8')
  expect(metadata.scripts?.builder).toBe('bunx electron-builder@25.1.8')
  for (const scriptName of packagingScripts) {
    expect(metadata.scripts?.[scriptName]).toContain('bun run builder')
    expect(metadata.scripts?.[scriptName]).not.toMatch(/(?:^|&&\s*)electron-builder\b/)
  }
  expect(distSource).toContain("const builderArgs = ['run', 'builder', `--${opts.platform}`]")
  expect(distSource).toContain("runStep('Electron Builder', 'bun', builderArgs")
  expect(releaseWorkflow).not.toMatch(/\b(?:npx|bunx) electron-builder(?:\s|$)/)
  expect(windowsWorkflow).not.toMatch(/\b(?:npx|bunx) electron-builder(?:\s|$)/)
  expect(releaseWorkflow.match(/bun run builder/g)).toHaveLength(4)
  expect(windowsWorkflow.match(/bun run builder/g)).toHaveLength(1)
})

test('Release 原生依赖工具链使用固定 Bun 与 node-gyp 版本', () => {
  /** monorepo 根包元数据。 */
  const metadata = readRootPackageMetadata()
  /** 正式 Release 工作流原始文本。 */
  const releaseWorkflow = readReleaseWorkflow()
  /** 独立 Windows 构建工作流原始文本。 */
  const windowsWorkflow = readWindowsBuildWorkflow()

  expect(metadata.packageManager).toBe('bun@1.3.14')
  expect(metadata.devDependencies?.['node-gyp']).toBe('12.4.0')
  expect(releaseWorkflow).not.toContain('bun-version: latest')
  expect(windowsWorkflow).not.toContain('bun-version: latest')
  expect(releaseWorkflow.match(/bun-version: 1\.3\.14/g)).toHaveLength(5)
  expect(windowsWorkflow.match(/bun-version: 1\.3\.14/g)).toHaveLength(1)
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

  expect(metadata.version).toBe('0.19.31-bone.8')
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
  expect(readFileSync(resolve(import.meta.dir, '../electron-builder.yml'), 'utf8').match(/^linux:$/gm)).toHaveLength(1)
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
  /** 完成应用构建并清理 workspace 开发依赖的资源准备命令。 */
  const packagePrepare = "bun run --filter='@proma/electron' package:prepare:win"
  /** 独立 Windows 构建工作流。 */
  const buildWorkflow = Bun.YAML.parse(readWindowsBuildWorkflow()) as ReleaseWorkflow
  /** 正式发布工作流。 */
  const releaseWorkflow = Bun.YAML.parse(readReleaseWorkflow()) as ReleaseWorkflow

  for (const workflow of [buildWorkflow, releaseWorkflow]) {
    /** 当前 Windows job 的全部 shell 命令。 */
    const commands = workflowCommands(workflow.jobs?.['build-windows-x64'])
    expect(commands).toContain(stableDirectoryTests)
    expect(commands.indexOf(stableDirectoryTests)).toBeLessThan(commands.indexOf(packagePrepare))
  }
})

test('Windows 升级安装器展示既有版本和目录并保留完整性校验', () => {
  /** Electron Builder 的正式打包配置。 */
  const config = readElectronBuilderConfig()
  /** Windows 安装器自定义 NSIS include。 */
  const installerSource = readWindowsInstallerInclude()

  expect(config.nsis?.include).toBe('resources/installer.nsh')
  expect(installerSource).toContain('!macro customPageAfterChangeDir')
  expect(installerSource).toMatch(
    /!ifndef BUILD_UNINSTALLER[\s\S]*?Var upgradeInstallLocation[\s\S]*?Var upgradeDisplayVersion[\s\S]*?!endif/,
  )
  expect(installerSource).toMatch(
    /!macro customHeader[\s\S]*?!ifndef BUILD_UNINSTALLER[\s\S]*?Function createUpgradeSummaryPage[\s\S]*?!endif[\s\S]*?!macroend/,
  )
  expect(installerSource).toContain(
    'ReadRegStr $upgradeInstallLocation SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation',
  )
  expect(installerSource).toContain(
    'ReadRegStr $upgradeDisplayVersion SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion',
  )
  expect(installerSource).toContain('StrCpy $upgradeDisplayVersion "未知版本"')
  expect(installerSource).toMatch(/\$upgradeInstallLocation == ""[\s\S]*Abort/)
  expect(installerSource).toContain('$INSTDIR')
  expect(installerSource).toContain('${VERSION}')
  expect(installerSource).not.toContain('uninstallOldVersion')
  expect(installerSource).not.toContain('SetOutPath')
  expect(installerSource).not.toContain('/NCRC')
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
