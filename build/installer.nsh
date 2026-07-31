; IN-484: the app's backend subprocess (notetaker-backend.exe) is spawned
; detached and survives the installer's own kill of the Electron app —
; orphans then stack across install-over-running-app cycles and hold port
; 8787 (observed live on a fleet machine, 31 Jul 2026). Terminate it at
; install and uninstall init. /T takes the process tree; failures are fine
; (nothing running).

!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "notetaker-backend.exe"'
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /T /IM "notetaker-backend.exe"'
!macroend
