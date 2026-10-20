@echo off
setlocal
rem Usage: local_paperclip_onboard.bat <instance-id> [extra onboard options, e.g. --yes --run]
cd /d "%~dp0"

set "INSTANCE=%~1"
if "%INSTANCE%"=="" set /p "INSTANCE=New instance id: "
if "%INSTANCE%"=="" (
  echo Instance id is required.
  exit /b 1
)

set "CONFIG=%USERPROFILE%\.paperclip\instances\%INSTANCE%\config.json"
if exist "%CONFIG%" (
  echo Instance "%INSTANCE%" already exists: %CONFIG%
  echo Use local_paperclip_start.bat %INSTANCE% to start it, or choose another id.
  exit /b 1
)

rem onboard has no --instance option; the instance id is read from this variable.
set "PAPERCLIP_INSTANCE_ID=%INSTANCE%"
set "NO_PROXY=localhost,127.0.0.1,::1"
set "no_proxy=%NO_PROXY%"

shift
echo Creating Paperclip instance "%INSTANCE%"
call pnpm paperclipai onboard %1 %2 %3 %4 %5 %6 %7 %8 %9
if errorlevel 1 exit /b %errorlevel%

echo.
echo Done. Start it with: local_paperclip_start.bat %INSTANCE%
endlocal
