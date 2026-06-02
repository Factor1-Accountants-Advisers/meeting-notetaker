!macro customRemoveFiles
  ${if} ${isUpdated}
    DetailPrint "Meeting Note-Taker update: removing previous install directory with cmd rmdir."
  ${else}
    DetailPrint "Meeting Note-Taker uninstall: removing install directory with cmd rmdir."
  ${endif}

  ExecWait '"$SYSDIR\\cmd.exe" /C rmdir /S /Q "$INSTDIR"' $0
  ${if} $0 != 0
    DetailPrint "Meeting Note-Taker uninstall: cmd rmdir failed with code $0; retrying after a short delay."
    Sleep 2000
    ExecWait '"$SYSDIR\\cmd.exe" /C rmdir /S /Q "$INSTDIR"' $0
  ${endif}

  ${if} $0 != 0
    Abort `Can't remove "$INSTDIR".`
  ${endif}
!macroend
