; CC Hub インストーラーの追加処理(electron-builder の nsis.include)
; - インストール / 更新の前に、同梱の node で動いているデーモン(cc-hub-node.exe)を止める(ファイルを置き換えるため)
; - アンインストール時(更新ではないとき)は、Claude Code から CC Hub の hooks・MCP・mod を外し、ログイン時の起動を消す

!macro customInit
  nsExec::Exec 'taskkill /F /IM cc-hub-node.exe'
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM cc-hub-node.exe'
!macroend

!macro customRemoveFiles
  ${ifNot} ${isUpdated}
    nsExec::Exec '"$INSTDIR\resources\hub\cc-hub-node.exe" "$INSTDIR\resources\hub\integrations\hooks\install.js" --uninstall --apply'
    nsExec::Exec '"$INSTDIR\resources\hub\cc-hub-node.exe" "$INSTDIR\resources\hub\integrations\mcp\install.js" --uninstall --apply'
    nsExec::Exec '"$INSTDIR\resources\hub\cc-hub-node.exe" "$INSTDIR\resources\hub\integrations\mod\install.js" --uninstall --apply'
    nsExec::Exec 'taskkill /F /IM cc-hub-node.exe'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CC Hub"
  ${endif}
  RMDir /r $INSTDIR
!macroend
