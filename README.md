# Pine & Co Seoul — 통합 시스템 v3 (버그 수정)

## v3 수정 내역 (2026-04-24)
**웨이팅이 Day View에 안 뜨던 문제 해결**

### 원인
`checkReturning` 함수에서 오래된 방문자 레코드 (`visits` 필드 없음) 처리 시
TypeError 발생 → `/api/new-today` 500 에러 → 연쇄적으로 큐 동기화 실패

### 해결
`server.js` 내 `checkReturning` 함수에 안전장치 추가.
이제 어떤 포맷의 visitors.json도 안전하게 처리됩니다.

## 배포
GitHub에 이 파일들을 통째로 덮어쓰기하면 Render가 자동 재배포합니다.

## URL
- `/reserve.html` - 예약 접수
- `/customer.html` - 웨이팅 등록
- `/manage.html` - 스태프 관리 (PIN: 1234)
