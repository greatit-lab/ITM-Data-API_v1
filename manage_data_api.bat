@echo off
setlocal enabledelayedexpansion
title ITM Vision SSO - Nginx & Backend Integration Manager
color 0A

:: -----------------------------------------------------------
:: ITM.Vision_SSO_v1 Server Management Tool (Nginx Edition)
:: 화면 출력 오류(BOM) 및 스킵 방지 완벽 해결본
:: -----------------------------------------------------------

:: [핵심 설정 1] Nginx 설치 경로 (사용자 제공 정보)
set "NGINX_HOME=C:\nginx"

:: [핵심 설정 2] PM2 경로 (폐쇄망/일반망 자동 대응)
set "TARGET_PM2_HOME=C:\nodejs\node_modules\pm2"

:INIT_CHECK
cls
echo [INIT] Configuring Runtime Environment...

:: 1. Nginx 확인
if not exist "%NGINX_HOME%\nginx.exe" (
    color 0C
    echo [CRITICAL ERROR] Nginx executable not found at:
    echo "%NGINX_HOME%\nginx.exe"
    echo.
    echo Please check the NGINX_HOME variable in this batch file.
    goto WAIT_KEY
)

:: 2. Node.js 확인
set "NODE_EXEC=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "C:\nodejs\node.exe" (
        set "NODE_EXEC=C:\nodejs\node.exe"
    ) else (
        echo [CRITICAL ERROR] Node.js executable not found.
        goto WAIT_KEY
    )
)

:: 3. PM2 명령어 조립
set "PM2_SCRIPT=%TARGET_PM2_HOME%\bin\pm2"
if not exist "%PM2_SCRIPT%" (
    echo [CRITICAL ERROR] PM2 core script not found at: "%PM2_SCRIPT%"
    goto WAIT_KEY
)
set "PM2_CMD="%NODE_EXEC%" "%PM2_SCRIPT%""

echo [OK] Nginx found at: %NGINX_HOME%
echo [OK] PM2 Ready.
timeout /t 1 >nul

:MENU
cls
set "action="
echo ===============================================================
echo   ITM Vision SSO Server Manager (Nginx + NestJS)
echo ===============================================================
echo.
echo   [Full Stack Control]
echo   1. Start All System  (Nginx + Backend)
echo   2. Restart All       (Reload Nginx + Restart Backend)
echo   3. Stop All          (Shutdown Nginx + Stop Backend)
echo   4. Delete Backend    (PM2 Process Cleanup)
echo.
echo   [Monitoring]
echo   5. Process List      (PM2 Status)
echo   6. View Backend Logs (itm-vision-backend)
echo   7. Monitor Dashboard
echo.
echo   0. Exit
echo.
echo ===============================================================
set /p action="Select an option (0-7): "

if "%action%"=="1" goto START_ALL
if "%action%"=="2" goto RESTART_ALL
if "%action%"=="3" goto STOP_ALL
if "%action%"=="4" goto DELETE_ALL
if "%action%"=="5" goto LIST_PROD
if "%action%"=="6" goto LOGS_BACK
if "%action%"=="7" goto MONIT_PROD
if "%action%"=="0" goto EXIT

goto MENU

:: -----------------------------------------------------------
:: 공통 대기 화면 (화면 스킵 완벽 차단)
:: -----------------------------------------------------------
:WAIT_KEY
echo.
echo ===============================================================
echo [DONE] Press any key to return to the menu...
timeout /t 1 >nul 
pause >nul
goto MENU

:: -----------------------------------------------------------
:: Logic Sections
:: -----------------------------------------------------------

:START_ALL
cls
echo [INFO] Starting Backend (PM2)...
echo ---------------------------------------------------
if not exist ecosystem.web.config.js (
    echo [ERROR] 'ecosystem.web.config.js' not found.
    goto WAIT_KEY
)
call !PM2_CMD! start ecosystem.web.config.js

echo.
echo [INFO] Starting Nginx Web Server...
echo ---------------------------------------------------
cd /d "%NGINX_HOME%"
start nginx.exe
cd /d "%~dp0"

echo.
echo [SUCCESS] System Started. Web Access Available.
goto WAIT_KEY

:RESTART_ALL
cls
echo [INFO] Restarting Backend...
echo ---------------------------------------------------
call !PM2_CMD! restart all

echo.
echo [INFO] Reloading Nginx Configuration...
echo ---------------------------------------------------
cd /d "%NGINX_HOME%"
nginx.exe -s reload
cd /d "%~dp0"

echo.
echo [SUCCESS] System Reloaded.
goto WAIT_KEY

:STOP_ALL
cls
echo [INFO] Stopping Backend...
echo ---------------------------------------------------
call !PM2_CMD! stop all

echo.
echo [INFO] Shutting down Nginx...
echo ---------------------------------------------------
cd /d "%NGINX_HOME%"
nginx.exe -s stop 2>nul
taskkill /F /IM nginx.exe /T 2>nul
cd /d "%~dp0"

echo.
echo [SUCCESS] All Servers Stopped. Site is OFFLINE.
goto WAIT_KEY

:DELETE_ALL
cls
echo [WARNING] Deleting PM2 Processes...
echo ---------------------------------------------------
call !PM2_CMD! delete all
goto WAIT_KEY

:LIST_PROD
cls
echo [INFO] Current PM2 Process List
echo ---------------------------------------------------
call !PM2_CMD! list
echo.
echo [INFO] Checking Nginx Process Status...
tasklist /FI "IMAGENAME eq nginx.exe"
echo.
goto WAIT_KEY

:LOGS_BACK
cls
echo [INFO] Streaming Backend Logs...
call !PM2_CMD! logs itm-vision-backend
goto WAIT_KEY

:MONIT_PROD
cls
call !PM2_CMD! monit
goto WAIT_KEY

:EXIT
endlocal
exit
