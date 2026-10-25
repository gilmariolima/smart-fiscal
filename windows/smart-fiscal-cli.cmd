@echo off
rem Linha de comando das notas (SEFAZ) do Smart Fiscal instalado (uso avancado), sem precisar do Node.js.
rem Fica na pasta resources do programa. Exemplos:
rem   smart-fiscal-cli.cmd status
rem   smart-fiscal-cli.cmd manifestar --help
rem Feche o Smart Fiscal (icone perto do relogio ^> Sair) antes de comandos que mexem no banco.
setlocal
if not defined SMARTDOC_DADOS set "SMARTDOC_DADOS=%LOCALAPPDATA%\Smart Fiscal\dados\notas"
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\Smart Fiscal.exe" "%~dp0app.asar\src\cli.js" %*
