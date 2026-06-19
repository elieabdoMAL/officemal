@echo off
REM OfficeMal Kiosk Startup Script
REM Place this in Task Scheduler to run at boot (before login, with highest privileges)
REM Waits for network, then opens Chrome in kiosk mode.

:WAIT_FOR_NETWORK
ping -n 1 8.8.8.8 >nul 2>&1
if errorlevel 1 (
    timeout /t 5 /nobreak >nul
    goto WAIT_FOR_NETWORK
)

REM Give Windows a moment to finish loading desktop
timeout /t 5 /nobreak >nul

REM Launch Chrome in kiosk mode pointing to OfficeMal
REM Replace YOUR_OFFICEMAL_URL with your actual deployed URL (e.g. https://officemal.vercel.app)
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --kiosk ^
  --no-first-run ^
  --disable-restore-session-state ^
  --disable-session-crashed-bubble ^
  --disable-infobars ^
  --disable-translate ^
  --autoplay-policy=no-user-gesture-required ^
  https://YOUR_OFFICEMAL_URL
