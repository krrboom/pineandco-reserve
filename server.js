// ═══════════════════════════════════════════════════════════
//  Pine & Co — Redirect Server (waiting → reserve unified app)
//
//  옛 waiting 앱으로 오는 모든 요청을 새 통합 앱으로 안내.
//  - 가게 QR 코드는 그대로 유지
//  - 직원도 자동으로 새 매니지 페이지로 이동
//  - 데이터는 reserve 앱에 일원화
// ═══════════════════════════════════════════════════════════

const http = require('http');

const TARGET = 'https://pineandco-reserve.onrender.com';
const PORT = process.env.PORT || 3000;

function mapPath(oldPath) {
  const [path, ...queryParts] = oldPath.split('?');
  const query = queryParts.length ? '?' + queryParts.join('?') : '';
  let newPath = path;
  // 직원 페이지 경로 매핑: staff.html → manage.html
  if (path === '/staff.html' || path === '/staff') newPath = '/manage.html';
  // API 경로도 매핑 (혹시 직접 호출 있을 경우)
  return newPath + query;
}

const server = http.createServer((req, res) => {
  const mappedPath = mapPath(req.url || '/');
  const newUrl = TARGET + mappedPath;
  console.log(`[REDIRECT] ${req.url} → ${newUrl}`);

  // 302 (Temporary)를 쓰는 이유:
  // - 301은 영구라 브라우저가 영원히 캐시 → 향후 변경 시 못 풀음
  // - 302는 매번 확인 → 유연성 확보
  // Cache-Control: no-store도 추가 → 브라우저가 캐시 안 함
  res.writeHead(302, {
    'Location': newUrl,
    'Cache-Control': 'no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=${newUrl}">
  <title>이동 중... / Redirecting</title>
  <style>
    body{font-family:-apple-system,sans-serif;background:#1e1208;color:#f0ebe0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;}
    .box{max-width:400px;padding:24px;}
    h1{color:#b8935a;font-weight:400;font-size:18px;letter-spacing:0.1em;font-family:Georgia,serif;}
    p{color:#8a7560;font-size:14px;line-height:1.6;}
    a{color:#c9a96e;}
  </style>
</head>
<body>
  <div class="box">
    <h1>🌲 PINE &amp; CO SEOUL</h1>
    <p>페이지 이동 중... / Redirecting...<br>
       자동으로 이동하지 않으면<br>
       <a href="${newUrl}">여기를 클릭</a>하세요.</p>
  </div>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log(`🔀 Redirect server running on port ${PORT}`);
  console.log(`   All requests → ${TARGET}`);
  console.log(`   Special: /staff → /manage.html`);
});
