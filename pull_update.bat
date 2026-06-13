@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  실시간 가격 모니터: 매일 GitHub 최신 코드 받기 (#1)
REM  - git pull 로 코드 갱신
REM  - background.js / manifest.json 이 바뀐 경우에만 크롬 재시작
REM    (팝업/CSS 변경은 팝업 다시 열 때 자동 반영되므로 재시작 불필요)
REM  ※ 크롬 강제 종료 후 재실행하므로, 안 쓰는 시간(예: 새벽)에 스케줄 권장
REM ============================================================

set "REPO=C:\Users\1\Desktop\실시간가격모니터\claude"
set "LOG=%REPO%\logs\pull.log"

cd /d "%REPO%"
echo.>> "%LOG%"
echo [%date% %time%] pull 시작 >> "%LOG%"

REM --- pull 이전 커밋 해시 ---
set "BEFORE="
for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "BEFORE=%%i"

git pull origin main >> "%LOG%" 2>&1

REM --- pull 이후 커밋 해시 ---
set "AFTER="
for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "AFTER=%%i"

if "!BEFORE!"=="!AFTER!" (
  echo [%date% %time%] 변경 없음 - 재시작 불필요 >> "%LOG%"
  goto :done
)

REM --- background.js / manifest.json 변경 여부 확인 ---
git diff --name-only "!BEFORE!" "!AFTER!" | findstr /I /C:"background.js" /C:"manifest.json" >nul
if errorlevel 1 (
  echo [%date% %time%] 변경 있으나 background/manifest 무관 - 재시작 생략 >> "%LOG%"
  goto :done
)

echo [%date% %time%] background/manifest 변경 감지 - 크롬 재시작 >> "%LOG%"
taskkill /IM chrome.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "!CHROME!" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
start "" "!CHROME!"
echo [%date% %time%] 크롬 재시작 완료 >> "%LOG%"

:done
echo [%date% %time%] pull 종료 >> "%LOG%"
endlocal
