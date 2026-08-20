import { describe, expect, test } from 'bun:test'
import { buildWslBashArgs, windowsPathToWslPath } from './pi-agent-adapter'

describe('Pi WSL Bash', () => {
  test('Given a Windows workspace path When building WSL Bash arguments Then uses its mounted Linux path', () => {
    expect(buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'pwd',
      undefined,
    )).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/mnt/c/Users/alice/Workspace/project',
      '--exec',
      'bash',
      '-lc',
      'pwd',
    ])
  })

  test('Given a Linux path When converting for WSL Then leaves it unchanged', () => {
    expect(windowsPathToWslPath('/home/alice/project')).toBe('/home/alice/project')
  })

  test('Given Windows 活动数据根 When 构建 WSL 命令 Then 通过环境变量注入转换后的路径', () => {
    /** 恢复命令本身不携带 Windows 路径，统一依赖运行时环境。 */
    const args = buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      '"$PROMA_CLI" session info session-1',
      {
        PROMA_CLI: 'C:\\Program Files\\Proma\\proma.exe',
        PROMA_CONFIG_DIR: 'D:\\Proma Data',
      },
    )
    const command = args.at(-1) ?? ''

    expect(command).toContain("export PROMA_CLI='/mnt/c/Program Files/Proma/proma.exe'")
    expect(command).toContain("export PROMA_CONFIG_DIR='/mnt/d/Proma Data'")
    expect(command).toContain('"$PROMA_CLI" session info session-1')
    expect(command).not.toContain('--config-dir')
    expect(command).not.toContain('D:\\Proma Data')
  })
})
