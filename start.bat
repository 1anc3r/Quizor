@echo off

node -v >nul 2>&1
if errorlevel 1 (
    echo [Error] Node.js not detected. Please install Node.js 18 or above first
    pause
    exit /b 1
)
echo [Success] Environment check passed
echo.

echo [Info] Starting the service...
if not exist "node_modules" (
    echo [Info] Installing dependencies...
    call npm install
)
start cmd /c "npm run dev & pause"
echo [Success] The service has been started
echo.

pause