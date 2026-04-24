# 🔀 옛날 앱 리다이렉트 서버

## 이게 뭐예요?

`pineandco-waiting.onrender.com` (옛날 앱)으로 오는 모든 요청을
`pineandco-reserve.onrender.com` (통합 앱)으로 자동 이동시켜주는 초간단 서버입니다.

비유: **"이사 갔습니다. 새 주소는 여기입니다"** 안내판 역할

## 배포 방법

`pineandco-waiting` GitHub 저장소의 **모든 파일을 이 파일들로 덮어쓰기**하시면 됩니다.

기존 파일(customer.html, staff.html, 옛 server.js 등)은 다 사라져도 됩니다.
이 3개 파일만 있으면 리다이렉트 서버로 동작해요:

- `server.js` (리다이렉트 로직)
- `package.json`
- `Procfile`

## 작동 확인

배포 후 브라우저에서 `https://pineandco-waiting.onrender.com/customer.html` 접속
→ 자동으로 `https://pineandco-reserve.onrender.com/customer.html` 로 이동됨

QR코드 스캔해도 마찬가지로 자동 이동!
