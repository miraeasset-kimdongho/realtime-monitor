@echo off
REM === 실시간 가격 모니터: GitHub에서 최신 코드 받아오기 (#1) ===
REM 작업 스케줄러에 하루 1회 등록해서 사용하세요.
REM 주의: git pull로 파일은 갱신되지만, 크롬은 확장을 자동 재로드하지 않습니다.
REM       코드 변경을 즉시 반영하려면 chrome://extensions 에서 새로고침(또는 크롬 재시작)이 필요합니다.

cd /d "C:\Users\1\Desktop\실시간가격모니터\claude"

echo [%date% %time%] pull 시작 >> "%~dp0logs\pull.log"
git pull origin main >> "%~dp0logs\pull.log" 2>&1
echo [%date% %time%] pull 종료 (exit=%errorlevel%) >> "%~dp0logs\pull.log"
