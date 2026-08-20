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

  test('Given bundled Windows CLI When 构建 WSL 命令 Then CLI 转为挂载路径但配置根保留 Win32 格式', () => {
    /** Windows exe 由 WSL interop 启动，进程内部仍使用 Win32 路径解析。 */
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
    expect(command).toContain("export PROMA_CONFIG_DIR='D:\\Proma Data'")
    expect(command).toContain('"$PROMA_CLI" session info session-1')
    expect(command).not.toContain('--config-dir')
    expect(command).not.toContain('/mnt/d/Proma Data')
  })

  test('Given WSL 原生 CLI When 构建 WSL 命令 Then 配置根转换为挂载路径', () => {
    /** 非 Windows exe 由 WSL 自身解析配置路径。 */
    const args = buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      '"$PROMA_CLI" session info session-1',
      {
        PROMA_CLI: '/usr/local/bin/proma',
        PROMA_CONFIG_DIR: 'D:\\Proma Data',
      },
    )
    const command = args.at(-1) ?? ''

    expect(command).toContain("export PROMA_CLI='/usr/local/bin/proma'")
    expect(command).toContain("export PROMA_CONFIG_DIR='/mnt/d/Proma Data'")
    expect(command).not.toContain("export PROMA_CONFIG_DIR='D:\\Proma Data'")
  })

  test('Given WSL PATH 中的 proma When 构建 WSL 命令 Then 配置根转换为挂载路径', () => {
    /** 未设置 PROMA_CLI 时，命令由 WSL PATH 中的原生 proma 处理。 */
    const args = buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'proma session info session-1',
      { PROMA_CONFIG_DIR: 'D:\\Proma Data' },
    )
    const command = args.at(-1) ?? ''

    expect(command).toContain("export PROMA_CONFIG_DIR='/mnt/d/Proma Data'")
    expect(command).not.toContain('export PROMA_CLI=')
  })
})
