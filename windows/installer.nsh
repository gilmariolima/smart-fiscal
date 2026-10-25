; Extras do instalador do app (electron-builder / NSIS).

!macro customUnInstall
  ; Desinstalacao de verdade (nao a troca de versao): tira o Smart Fiscal da inicializacao do Windows.
  ; Os dados (%LOCALAPPDATA%\Smart Fiscal\dados) ficam: certificados, XMLs, o .env com a MASTER_KEY e os SPEDs.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Smart Fiscal"
  ${endIf}
!macroend
