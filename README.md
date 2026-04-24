# Pine & Co Seoul — 통합 시스템 (Unified v1)

**구 시스템 2개(`pineandco-waiting`, `pineandco-reserve`)를 하나의 Render 앱으로 통합한 버전입니다.**

비유하자면 — 원래 홀 매니저(예약)와 입구 담당자(웨이팅) 두 명이 따로 일하던 것을, 이제 **한 명의 매니저가 양쪽을 한 눈에 보고 관리**할 수 있게 만든 거예요.

---

## 📂 파일 구조

```
pineandco-unified/
├── server.js           # 통합 백엔드 (1,825줄, Express)
├── package.json        # 의존성: express, nodemailer, googleapis
├── Procfile            # web: node server.js
└── public/
    ├── reserve.html    # 예약 게스트 페이지 (변경 없음)
    ├── customer.html   # 웨이팅 게스트 페이지 (변경 없음)
    ├── manage.html     # 통합 스태프 대시보드 (신규)
    └── game.html       # 칵테일 랩 게임 (변경 없음)
```

---

## 🌐 URL 라우팅

배포 후 단일 도메인(예: `https://pineandco-reserve.onrender.com`)에서 모두 동작합니다.

| 경로 | 용도 |
|------|------|
| `/` → `/reserve.html` | 루트 접근시 예약 페이지로 리다이렉트 |
| `/reserve.html` | 예약 접수 (게스트용) |
| `/customer.html` | 웨이팅 등록 (게스트용, 입구 태블릿) |
| `/manage.html` | 🔑 **스태프 대시보드 (PIN: `1234`)** |
| `/game.html` | 칵테일 랩 게임 |
| `/t/:id` | 웨이팅 SMS 짧은 링크 → customer.html로 리다이렉트 |

---

## 🏠 manage.html — 4개 탭

### 1️⃣ Today
- 오늘 날짜 헤더
- **📩 오늘 들어온 예약** (신규, 미확인) — 각 카드마다 **✅ 확인** 버튼으로 하나씩 체크
  - *기존 `bookings.html`의 기능이 여기로 통합됨*
- 🕒 **현재 웨이팅** — 오늘 대기중인 팀을 한눈에
- 📊 통계 카드 (오늘 예약 · 총 인원 · 미확인)
- 시간대별 예약 리스트 (19:00 / 20:00 / 21:00 / 23:00)

### 2️⃣ Calendar
- 월별 캘린더 뷰 (이벤트 표시, 예약 건수, 다음달 이동)
- 날짜에 마우스 올리면 **E** 버튼 → 이벤트 설정 가능

### 3️⃣ Day View ⭐ 핵심 변경
- 플로어 레이아웃 SVG (B1–B14, T1–T4, H1–H2, ROOM, TEMP1–2)
- **🕒 웨이팅 사이드바** (오른쪽, 모바일에서는 아래에 스크롤) — 예약 관리하면서 웨이팅도 동시에!
- 좌석 클릭 시 팝업으로 SEATED / NO-SHOW / 자리 이동 / 교환 / 노티 / 시간제한 / **이름 수정 / 메모 수정 / 삭제**까지 모두 가능
- 시간대 탭 (ALL, 19:00, 20:00, ...)
- 직원용 수동 예약 추가 폼

### 4️⃣ Settings ⭐ 정리됨
- **직원 관리** 🔒 (Admin PIN: `0000`)
- **이벤트 관리** (대관 날짜 차단)
- **📥 캘린더 복붙 일괄 입력** — *기존 `bookings.html`에서 이동*
- **📜 예약 히스토리 (완료/노쇼)** — *기존 `bookings.html`에서 이동*
- **📅 Google Calendar 연동** (동기화 / 진단 / 비교)
- **📊 Google Sheets 연동** (헤더 초기화)
- **🔒 데이터 안전** (상태 확인 / 백업 목록 / 복구)

---

## 🔔 웨이팅 알림 플로우 (NOTIFY 클릭 시)

1. 스태프가 웨이팅 카드의 `NOTIFY` 클릭
2. 전체 화면 좌석 선택 모달이 뜸 (B1–B14 / T1–T4 / H1–H2 / ROOM)
3. 예약으로 찜된 좌석 + 이미 호출된 손님의 좌석은 회색 처리 (선택 불가)
4. 바 좌석은 인원수만큼 여러 개 선택 가능
5. 확인 시 손님 폰번호로 Aligo(국내) 또는 Twilio(해외) SMS 발송 + 이메일(Gmail SMTP)
6. 5분 카운트다운 시작 — 시간 초과시 자동 취소 + 취소 메시지 발송

---

## ⚙️ 환경변수 (Render 대시보드에서 설정)

아래는 **모두 `server.js`에 fallback 값이 하드코딩되어 있어** 따로 설정 안 해도 기본 동작합니다. 필요할 때만 재정의하면 돼요.

```
# 기본 접근
PORT                = (Render 자동 설정)
PUBLIC_URL          = https://pineandco-reserve.onrender.com
STAFF_PIN           = 1234
ADMIN_PIN           = 0000
BUSINESS_PHONE      = 010-6817-0406
AUTO_CANCEL_MIN     = 5

# SMS (Aligo — 국내)
ALIGO_KEY           = rh3n2s1roxzkir7k40s2uud6t56n80uk
ALIGO_USER_ID       = pineandcoseoul
ALIGO_SENDER        = 01068170406

# KakaoTalk Alimtalk (선택)
KAKAO_SENDER_KEY    = 0fb72a35d7e535142a1863909dddd879687eabb8
TPL_JOIN            = (승인된 템플릿 코드)
TPL_CALL            = (승인된 템플릿 코드)
TPL_CANCEL          = (승인된 템플릿 코드)

# SMS (Twilio — 해외)
TWILIO_SID          = AC4240cb85035b38453f598974ae9d3e91
TWILIO_TOKEN        = ff11036c4c74209ec1d2874deff960ce
TWILIO_FROM         = +12602548266

# Email (Gmail SMTP)
GMAIL_USER          = pineandcoseoul@gmail.com
GMAIL_PASS          = akgr cssw thpc hgaa

# Google Services (선택, 미설정시 기능만 비활성)
GOOGLE_CLIENT_EMAIL = ...
GOOGLE_PRIVATE_KEY  = "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_CALENDAR_ID  = ...
GOOGLE_SHEET_ID     = ...

# 데이터 저장 경로 (Render 영구 디스크 권장)
DATA_DIR            = /var/data
```

---

## 🗂 데이터 파일 (모두 `DATA_DIR` 아래)

| 파일 | 용도 |
|------|------|
| `reservations.json` | 예약 전체 |
| `events.json` | 대관/이벤트 날짜 |
| `staff.json` | 직원 목록 |
| `visitors.json` | 재방문 고객 추적 |
| `queue.json` | 현재 웨이팅 큐 |
| `queue.backup.json` | 큐 백업 |
| `waiting_history.json` | 오늘의 웨이팅 히스토리 (9시 리셋) |
| `backups/` | 예약 시간별 자동 백업 (최근 48시간) |

**매일 오전 9시(KST) 자동 리셋**: 웨이팅 큐 + 웨이팅 히스토리만. *예약은 건드리지 않음.*

---

## 🚀 배포 방법

### 방법 A: 기존 `pineandco-reserve` Render 앱에 덮어쓰기 (권장)

1. 기존 앱의 GitHub 저장소(`github.com/krrboom/pineandco-reserve`)에 이 파일들을 push
2. Render가 자동 재배포
3. `pineandco-waiting` 앱은 그대로 두거나, 비용 절약을 위해 일시정지/삭제

### 방법 B: 새 Render 앱 생성

1. 이 폴더를 새 GitHub 저장소에 push
2. Render에서 Web Service 신규 생성, 해당 저장소 연결
3. `DATA_DIR`을 영구 디스크(Persistent Disk)로 마운트
4. 필요 환경변수 설정

---

## ✅ API 엔드포인트 정리

**공통:**
- `GET /api/config` — 공개 설정
- `GET /api/stream` — SSE (웨이팅 실시간)

**웨이팅 시스템** (customer.html 호환 — 엔드포인트 변경 없음):
- `GET /api/queue` · `POST /api/queue/join` · `POST /api/queue/call/:id` · `POST /api/queue/seat/:id` · `POST /api/queue/swap` · `POST /api/queue/decline/:id` · `POST /api/queue/done/:id` · `POST /api/queue/undo/:id` · `DELETE /api/queue/:id`
- `GET /api/waiting/history` ⭐ 네임스페이스 변경 (기존 `/api/history`와 충돌 방지)
- `GET /api/waiting/close`

**예약 시스템** (reserve.html 호환):
- `POST /api/reserve` — 게스트 예약 접수
- `GET /api/availability/:date` · `GET /api/reservations/:date` · `GET /api/month/:year/:month`
- `POST /api/staff/reserve` · `POST /api/walkin` · `POST /api/swap-seats` · `PATCH /api/reservations/:id` · `DELETE /api/reservations/:id`
- `GET /api/history` — 예약 히스토리 (완료/노쇼)
- `GET /api/new-today` — 오늘 들어온 예약
- `GET /api/staff-names` · `POST /api/staff-names` · `DELETE /api/staff-names/:name`
- `GET /api/events` · `POST /api/events/:date`
- `POST /api/bulk-import` — 캘린더 복붙 일괄 입력
- `POST /api/gcal-sync` · `POST /api/gcal-test` · `POST /api/gcal-report`
- `POST /api/sheet-setup`
- `GET /api/data-health` · `GET /api/backups` · `POST /api/restore-backup`

---

## 📝 변경 요약

1. **예약 시스템**을 베이스로 **웨이팅 시스템**을 흡수
2. `customer.html` / `reserve.html` / `game.html`은 **수정 없이** 그대로 이동 (기존 로직/브랜딩 유지)
3. `manage.html`은 **완전 재작성**:
   - 기존 `bookings.html`의 기능(오늘 예약 확인, 일괄 입력, 히스토리)을 Today/Settings로 통합
   - Day View에 웨이팅 사이드바 추가
   - 좌석 팝업에 SEATED/NO-SHOW/이름수정/메모수정/삭제 버튼 추가
4. 웨이팅 SMS 발송은 Gmail SMTP(이메일 + 스펨 안정적) + Aligo(국내 문자) + Twilio(해외 문자)
5. Resend 의존성 제거 (Gmail SMTP로 통합)
6. 일괄 입력과 히스토리 API는 그대로 유지 (기존 `bookings.html`의 내부 로직을 `manage.html`의 Settings 탭으로 이식)

---

## 🧪 배포 전 체크

```bash
# 로컬에서 실행해보기
cd pineandco-unified
npm install
node server.js

# 브라우저에서
http://localhost:3000/reserve.html    # 예약
http://localhost:3000/customer.html   # 웨이팅
http://localhost:3000/manage.html     # 스태프 (PIN: 1234)
```

---

**제작:** 2026.04.23 · Claude + 붐
