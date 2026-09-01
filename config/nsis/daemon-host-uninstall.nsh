; Clean up the relocated terminal daemon on a REAL uninstall.
;
; Why: the daemon host is deliberately copied OUT of the install dir into
; %LOCALAPPDATA%\Orca\daemon-host so that app UPDATES cannot kill it —
; electron-builder's kill sweep selects processes whose image path is under
; $INSTDIR, and that relocation is what keeps terminals alive across updates.
; The same design means a normal uninstall's process sweep and file removal both
; miss it, leaving an orphaned daemon plus its runtime copy behind.
;
; The ${isUpdated} guard is essential: electron-builder runs this uninstaller as
; part of uninstallOldVersion on EVERY update, and killing the daemon there would
; defeat the whole feature. Only clean up on a genuine uninstall.
;
; The LOCALAPPDATA folder name must stay in sync with LOCAL_HOST_ROOT_NAME in
; src/main/daemon/daemon-host-relocation.ts. See
; docs/reference/windows-daemon-host-relocation.md.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    ; The host exe is a verbatim copy of the app exe, so the app's own image name
    ; reaches it; the second name covers hosts left by builds that renamed the copy.
    ; Both are the product being uninstalled, so a name-wide kill has no collateral.
    nsExec::Exec 'taskkill /F /IM ${APP_EXECUTABLE_FILENAME}'
    Pop $0
    nsExec::Exec 'taskkill /F /IM orca-terminal-daemon.exe'
    Pop $0
    Pop $0
    ; Give the OS a moment to release the image lock before removing the tree.
    Sleep 500
    RMDir /r "$LOCALAPPDATA\Orca\daemon-host"
  ${endIf}
!macroend
