@echo off
setlocal

set "LOG=C:\OEM\winutil-firstboot.log"

echo [%DATE% %TIME%] Starting Winutil first-boot hook.>>"%LOG%"

if exist "C:\OEM\winutil-config.json" (
  echo [%DATE% %TIME%] Found winutil-config.json, running Winutil without UI.>>"%LOG%"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; & ([ScriptBlock]::Create((irm https://github.com/ChrisTitusTech/winutil/releases/latest/download/winutil.ps1))) -Config 'C:\OEM\winutil-config.json' -Noui" >>"%LOG%" 2>&1
) else (
  echo [%DATE% %TIME%] No winutil-config.json found, launching Winutil UI.>>"%LOG%"
  start "" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm 'https://christitus.com/win' | iex"
)

echo [%DATE% %TIME%] Winutil first-boot hook finished.>>"%LOG%"
exit /b 0
