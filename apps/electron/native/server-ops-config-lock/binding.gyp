{
  'targets': [{
    'target_name': 'server-ops-config-lock',
    'sources': ['server-ops-config-lock-addon.cc'],
    # 仅使用稳定 Node-API，使同一模块兼容 Electron 与独立 Node。
    'defines': ['NAPI_VERSION=8'],
    # 将 node.exe 的延迟导入重定向到当前 Electron/Proma 可执行文件。
    'win_delay_load_hook': 'true',
    'msvs_settings': {
      'VCCLCompilerTool': {
        'AdditionalOptions': ['/std:c++17', '/utf-8'],
        'ExceptionHandling': 1
      }
    }
  }]
}
