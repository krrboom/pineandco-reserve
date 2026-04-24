# Pine & Co Seoul — 통합 시스템

단일 Render 앱으로 예약 + 웨이팅 시스템 통합.

## 🚀 배포 방법

GitHub 저장소(`pineandco-reserve`)에 이 파일들을 그대로 덮어쓰기 하면 Render가 자동 재배포합니다.

## 📂 파일
- `server.js` - 백엔드
- `package.json` - 의존성
- `Procfile` - Render 시작 명령
- `public/reserve.html` - 예약 게스트 페이지
- `public/customer.html` - 웨이팅 게스트 페이지
- `public/manage.html` - 스태프 대시보드 (PIN: 1234)
- `public/game.html` - 칵테일 랩 게임

## 🌐 URL
- `/reserve.html` - 예약 접수
- `/customer.html` - 웨이팅 등록
- `/manage.html` - 스태프 관리
