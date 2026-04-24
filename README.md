# Pine & Co Seoul — 통합 시스템

단일 Render 앱으로 예약 + 웨이팅 시스템 통합.

## 🌐 URL

- `/reserve.html` - 예약 접수 (게스트)
- `/customer.html` - 웨이팅 등록 (게스트, 입구 태블릿)
- `/manage.html` - 스태프 대시보드 (PIN 필요)
- `/game.html` - 칵테일 랩 게임

## 📂 파일 구조

```
├─ server.js
├─ package.json
├─ Procfile
└─ public/
   ├─ customer.html
   ├─ reserve.html
   ├─ manage.html
   └─ game.html
```

## 🔐 환경변수 설정

모든 API 키와 비밀번호는 Render 대시보드의 Environment 탭에서만 설정합니다.
코드에는 하드코딩하지 않습니다.

## 🚀 배포

GitHub에 push → Render 자동 재배포.
