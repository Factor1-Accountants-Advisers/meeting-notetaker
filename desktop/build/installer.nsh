!macro customRemoveFiles
  ${if} ${isUpdated}
    DetailPrint "Meeting Note-Taker update: removing previous install directory directly."
  ${else}
    DetailPrint "Meeting Note-Taker uninstall: removing install directory directly."
  ${endif}

  ClearErrors
  RMDir /r "$INSTDIR"
  ${if} ${Errors}
    DetailPrint "Meeting Note-Taker uninstall: initial remove failed; retrying after a short delay."
    Sleep 2000
    ClearErrors
    RMDir /r "$INSTDIR"
  ${endif}

  ${if} ${Errors}
    Abort `Can't remove "$INSTDIR".`
  ${endif}
!macroend
