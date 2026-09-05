# 保存检测到的旧安装目录，只用于升级摘要展示。
Var upgradeInstallLocation
# 保存检测到的旧版本号，注册表缺失时显示“未知版本”。
Var upgradeDisplayVersion

# 在安装目录页之后注册升级摘要页，由页面创建函数决定是否跳过。
!macro customPageAfterChangeDir
  Page custom createUpgradeSummaryPage
!macroend

# 延后定义页面函数，确保 electron-builder 已加载 MUI、nsDialogs 与注册表上下文。
!macro customHeader
  # 按 electron-builder 已选定的安装作用域读取旧安装信息并创建只读摘要页。
  Function createUpgradeSummaryPage
    StrCpy $upgradeInstallLocation ""
    StrCpy $upgradeDisplayVersion ""

    ReadRegStr $upgradeInstallLocation SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $upgradeDisplayVersion SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion

    ${If} $upgradeInstallLocation == ""
      Abort
    ${EndIf}
    ${If} $upgradeDisplayVersion == ""
      StrCpy $upgradeDisplayVersion "未知版本"
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "升级现有 Proma" "确认旧版本与本次安装位置"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "检测到已安装版本：Proma $upgradeDisplayVersion"
    Pop $1
    ${NSD_CreateLabel} 0 28u 100% 36u "旧安装位置：$upgradeInstallLocation"
    Pop $1
    ${NSD_CreateLabel} 0 68u 100% 36u "本次安装位置：$INSTDIR"
    Pop $1
    ${NSD_CreateLabel} 0 112u 100% 42u "继续后将先卸载旧版本，保留本地业务数据与快捷方式，再安装 Proma ${VERSION}。"
    Pop $1

    nsDialogs::Show
  FunctionEnd
!macroend
