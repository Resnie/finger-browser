!include "LogicLib.nsh"
!define LEGACY_HELPER_SOURCE "${__FILEDIR__}\installer-legacy-upgrade.ps1"

!macro customInit
  ; Keep the original uninstall registration until the new installation succeeds.
!macroend

!ifndef BUILD_UNINSTALLER
  Var LegacyHelperExit
  Var LegacyHelperOutput
  Var LegacyCompatibilityUsed
  Var LegacyCompatibilityCommitted

  !macro RunLegacyCompatibility PHASE
    Push $0
    Push $9
    StrCpy $0 "$OUTDIR"
    SetOutPath "$TEMP"
    System::Call 'kernel32::SetEnvironmentVariable(t "FINGER_LEGACY_PHASE", t "${PHASE}") i.r9'
    System::Call 'kernel32::SetEnvironmentVariable(t "FINGER_LEGACY_ROOT", t "$INSTDIR") i.r9'
    System::Call 'kernel32::SetEnvironmentVariable(t "FINGER_LEGACY_EXPECTED", t "$PROGRAMFILES64\fingerbrowser") i.r9'
    System::Call 'kernel32::SetEnvironmentVariable(t "FINGER_LEGACY_RECEIPT", t "$PLUGINSDIR\legacy-receipt.json") i.r9'
    System::Call 'kernel32::SetEnvironmentVariable(t "FINGER_LEGACY_SCRIPT", t "$PLUGINSDIR\legacy-upgrade.ps1") i.r9'
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -EncodedCommand JgAgACgAWwBTAGMAcgBpAHAAdABCAGwAbwBjAGsAXQA6ADoAQwByAGUAYQB0AGUAKABbAEkATwAuAEYAaQBsAGUAXQA6ADoAUgBlAGEAZABBAGwAbABUAGUAeAB0ACgAJABlAG4AdgA6AEYASQBOAEcARQBSAF8ATABFAEcAQQBDAFkAXwBTAEMAUgBJAFAAVAApACkAKQA='
    Pop $LegacyHelperExit
    Pop $LegacyHelperOutput
    SetOutPath "$0"
    Pop $9
    Pop $0
  !macroend

  !macro customUnInstallCheck
    ${If} $R0 == 2
      InitPluginsDir
      SetOutPath "$PLUGINSDIR"
      File /oname=legacy-upgrade.ps1 "${LEGACY_HELPER_SOURCE}"
      StrCpy $LegacyCompatibilityUsed "1"
      !insertmacro RunLegacyCompatibility "stage"
      ${If} $LegacyHelperExit == 0
        DetailPrint "Old 0.2.0 installation preserved; continuing verified upgrade."
        StrCpy $R0 0
        ClearErrors
        Return
      ${EndIf}
      DetailPrint "$LegacyHelperOutput"
    ${EndIf}
    IfErrors 0 +3
    DetailPrint "Unable to launch the old uninstaller."
    Return
    ${If} $R0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "升级未完成，原安装与数据已保留。请保存并关闭浏览器后重试。"
      SetErrorLevel 2
      Quit
    ${EndIf}
  !macroend

  !macro customInstall
    ${If} $LegacyCompatibilityUsed == "1"
      !insertmacro RunLegacyCompatibility "commit"
      ${If} $LegacyHelperExit != 0
        DetailPrint "$LegacyHelperOutput"
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $LegacyCompatibilityCommitted "1"
    ${EndIf}
  !macroend

  Function .onGUIEnd
    ${If} $LegacyCompatibilityUsed == "1"
    ${AndIf} $LegacyCompatibilityCommitted != "1"
      !insertmacro RunLegacyCompatibility "rollback"
      ${If} $LegacyHelperExit != 0
        DetailPrint "$LegacyHelperOutput"
        MessageBox MB_OK|MB_ICONEXCLAMATION "升级未完成，旧安装备份仍保留。请联系管理员协助恢复。"
      ${EndIf}
    ${EndIf}
  FunctionEnd
!endif
