!macro customInit
  ; Let electron-builder preserve and read the existing uninstall registration.
  ; Deleting it here breaks upgrades and can orphan a cancelled installation.
!macroend
