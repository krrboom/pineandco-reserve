// ═══════════════════════════════════════════════════════════
//  Pine & Co — Redirect Server
//
//  옛날 pineandco-waiting 앱을 통합 앱(pineandco-reserve)으로
//  자동 리다이렉트하는 초간단 서버.
//
//  기존 QR 코드가 pineandco-waiting.onrender.com 을 가리키고
//  있어도, 손님은 자동으로 통합 앱으로 이동됩니다.
// ═══════════════════════════════════════════════════════════

const http = require('http');

const TARGET = 'https://pineandco-reserve.onrender.com';
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // 요청된 경로를 그대로 통합 앱으로 넘김 (쿼리스트링 포함)
  const newUrl = TARGET + (req.url || '/');

  console.log(`[REDIRECT] ${req.url} → ${newUrl}`);

  // 301 Moved Permanently — 브라우저가 영구적으로 기억해서 다음엔 더 빠름
  res.writeHead(301, {
    'Location': newUrl,
    'Cache-Control': 'public, max-age=3600' // 1시간 캐시
  });
  res.end(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=${newUrl}">
  <title>이동 중...</title>
  <style>
    body {
      font-family: -apple-system, sans-serif;
      background: #1e1208;
      color: #f0ebe0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      text-align: center;
    }
    .box { max-width: 400px; padding: 24px; }
    h1 { color: #b8935a; font-weight: 400; font-size: 18px; letter-spacing: 0.1em; }
    p { color: #8a7560; font-size: 14px; line-height: 1.6; }
    a { color: #c9a96e; }
  </style>
</head>
<body>
  <div class="box">
    <h1>🌲 PINE &amp; CO SEOUL</h1>
    <p>페이지 이동 중...<br>자동으로 이동하지 않으면<br><a href="${newUrl}">여기를 클릭</a>하세요.</p>
  </div>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log(`🔀 Redirect server running on port ${PORT}`);
  console.log(`   All requests → ${TARGET}`);
});
