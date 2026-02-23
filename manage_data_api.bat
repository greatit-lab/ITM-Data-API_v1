@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title ITM Data-API Server Manager (Port 8081)
color 0A

:: -----------------------------------------------------------
:: ITM.Vision Data-API Server Management Tool
:: 화면 깜빡임(스킵) 방지 및 한글 완벽 지원 패치 완료
:: -----------------------------------------------------------

:INIT_CHECK
cls
echo [INIT] Checking System Environment for Data API Server...

:: 1. Node.js 확인
set "NODE_EXEC=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_EXEC=C:\Program Files\nodejs\node.exe"
    ) else if exist "C:\nodejs\node.exe" (
        set "NODE_EXEC=C:\nodejs\node.exe"
    ) else (
        color 0C
        echo [CRITICAL ERROR] Node.js is not installed or not in PATH.
        pause
        exit
    )
)

:: 2. PM2 자동 감지
set "PM2_CMD="

where pm2 >nul 2>nul
if %errorlevel% equ 0 (
    set "PM2_CMD=pm2"
    echo [OK] Found Global PM2.
)

if "!PM2_CMD!"=="" (
    if exist "C:\Program Files\nodejs\node_modules\pm2\bin\pm2" (
        set "PM2_CMD="%NODE_EXEC%" "C:\Program Files\nodejs\node_modules\pm2\bin\pm2""
        echo [OK] Found PM2 in Program Files...
    ) else if exist "%APPDATA%\npm\node_modules\pm2\bin\pm2" (
        set "PM2_CMD="%NODE_EXEC%" "%APPDATA%\npm\node_modules\pm2\bin\pm2""
        echo [OK] Found User PM2...
    ) else if exist "C:\nodejs\node_modules\pm2\bin\pm2" (
        set "PM2_CMD="%NODE_EXEC%" "C:\nodejs\node_modules\pm2\bin\pm2""
        echo [OK] Found Local PM2 at C:\nodejs...
    ) else (
        color 0C
        echo [ERROR] PM2 not found in any directory.
        echo Web 서버의 C:\nodejs\node_modules\pm2 폴더를
        echo 현재 PC의 C:\Program Files\nodejs\node_modules\ 폴더 안으로 복사해주세요.
        pause
        exit
    )
)

echo [OK] Node.js and PM2 Ready.
timeout /t 1 >nul

:MENU
cls
:: 이전 입력값 초기화 (오작동 방지)
set "action=" 
echo ===============================================================
echo    ITM Vision Data-API Server Manager (Port 8081)
echo ===============================================================
echo.
echo    [Direct Execution - 안전 모드]
echo    0. Direct Start (Auto-kill 8081 + node dist/main.js)
echo.
echo    [PM2 Process Control - 백그라운드 운영]
echo    1. Start API Server  (PM2 Start)
echo    2. Restart API       (PM2 Restart)
echo    3. Stop API          (PM2 Stop)
echo    4. Delete Process    (PM2 Delete)
echo.
echo    [Monitoring]
echo    5. Process List      (PM2 Status)
echo    6. View API Logs     (PM2 Logs)
echo    7. Monitor Dashboard (PM2 Monit)
echo.
echo    8. Exit
echo.
echo ===============================================================
set /p action="메뉴를 선택하세요 (0-8): "

if "%action%"=="0" goto DIRECT_START
if "%action%"=="1" goto START_API
if "%action%"=="2" goto RESTART_API
if "%action%"=="3" goto STOP_API
if "%action%"=="4" goto DELETE_API
if "%action%"=="5" goto LIST_API
if "%action%"=="6" goto LOGS_API
if "%action%"=="7" goto MONIT_API
if "%action%"=="8" goto EXIT

goto MENU

:: -----------------------------------------------------------
:: [핵심 변경] 공통 대기 화면 (화면 스킵 완벽 차단)
:: -----------------------------------------------------------
:WAIT_KEY
echo.
echo ===============================================================
echo [완료] 결과를 모두 확인하셨다면 아무 키나 눌러 메뉴로 돌아가세요.
:: 1초 동안 키 입력을 강제로 무시하여 PM2의 찌꺼기 신호 흡수
timeout /t 1 >nul 
pause >nul
goto MENU

:: -----------------------------------------------------------
:: Logic Sections
:: -----------------------------------------------------------

:DIRECT_START
cls
echo [INFO] Preparing Direct Start (Auto-kill Port 8081)...
echo ---------------------------------------------------
call !PM2_CMD! kill >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1

echo [INFO] Releasing Port 8081...
powershell -Command "$pid_8081 = (Get-NetTCPConnection -LocalPort 8081 -ErrorAction SilentlyContinue).OwningProcess; if ($pid_8081) { Stop-Process -Id $pid_8081 -Force }"
timeout /t 2 >nul

echo [INFO] Starting Data-API (Direct Mode)...
echo ---------------------------------------------------
node dist/main.js
goto WAIT_KEY

:START_API
cls
echo [INFO] Starting Data-API (PM2)...
echo ---------------------------------------------------
if exist ecosystem.config.js (
    call !PM2_CMD! start ecosystem.config.js
) else (
    call !PM2_CMD! start dist/main.js --name "itm-data-api"
)
goto WAIT_KEY

:RESTART_API
cls
echo [INFO] Restarting Data-API...
echo ---------------------------------------------------
call !PM2_CMD! restart all
goto WAIT_KEY

:STOP_API
cls
echo [INFO] Stopping Data-API...
echo ---------------------------------------------------
call !PM2_CMD! stop all
goto WAIT_KEY

:DELETE_API
cls
echo [WARNING] Deleting PM2 Processes...
echo ---------------------------------------------------
call !PM2_CMD! delete all
goto WAIT_KEY

:LIST_API
cls
echo [INFO] Current PM2 Process List
echo ---------------------------------------------------
call !PM2_CMD! list
goto WAIT_KEY

:LOGS_API
cls
echo [INFO] Streaming API Logs... (종료하려면 Ctrl+C를 누르세요)
echo ---------------------------------------------------
call !PM2_CMD! logs
goto WAIT_KEY

:MONIT_API
cls
call !PM2_CMD! monit
goto WAIT_KEY

:EXIT
endlocal
exit
