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
    Push $1
    Push $2
    ; The host exe is a verbatim copy of the app exe, so the app's own image name
    ; reaches it; the second name covers hosts left by builds that renamed the copy.
    ; Filtered to the current user like upstream's per-user KILL_PROCESS, so an
    ; elevated machine-wide uninstall cannot reach another logged-on user's session.
    ; NSIS expands USERNAME itself: routing through cmd.exe only to get %USERNAME%
    ; would add two interpreter spawns to the uninstall path for nothing.
    ReadEnvStr $1 USERNAME
    ${if} $1 == ""
      ; Measured: taskkill rejects an empty filter value outright ("The search filter
      ; cannot be recognized") and kills nothing, so with no USERNAME to scope by,
      ; kill unfiltered rather than not at all. USERNAME is set in every session an
      ; uninstaller runs in, so this is a backstop, not the expected path.
      StrCpy $2 ""
    ${else}
      StrCpy $2 '/FI "USERNAME eq $1"'
    ${endIf}
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" $2'
    Pop $0
    nsExec::Exec 'taskkill /F /IM "orca-terminal-daemon.exe" $2'
    Pop $0
    Pop $2
    Pop $1
    Pop $0
    ; Give the OS a moment to release the image lock before removing the tree.
    Sleep 500
    RMDir /r "$LOCALAPPDATA\Orca\daemon-host"
  ${endIf}
!macroend
