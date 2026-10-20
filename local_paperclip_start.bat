@echo off
setlocal
rem Usage: local_paperclip_start.bat [instance-id]   (default: test-copilot)
cd /d "%~dp0"

set "INSTANCE=%~1"
if "%INSTANCE%"=="" set "INSTANCE=test-copilot"

rem Corporate HTTP_PROXY would otherwise send agents' localhost API calls to the proxy (403).
set NODE_USE_ENV_PROXY=1
set PAPERCLIP_REMOTE_HTTP_VIA_ENV_PROXY=true
set NODE_EXTRA_CA_CERTS=D:/temp3/cert_ca/cacert.pem
set "NO_PROXY=localhost,127.0.0.1,::1"
set "no_proxy=%NO_PROXY%"

netstat -ano | findstr /R /C:":3100 .*LISTENING" >nul
if not errorlevel 1 (
  echo Port 3100 is already in use. Stop the running Paperclip first.
  exit /b 1
)

echo Starting Paperclip instance "%INSTANCE%" at http://127.0.0.1:3100
call pnpm paperclipai run -i "%INSTANCE%"
endlocal
