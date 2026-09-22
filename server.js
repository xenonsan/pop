'use strict';

const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TARGET_HOST = 'sushida.net';
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
const ROOT = __dirname;

app.disable('x-powered-by');
app.set('trust proxy', true);

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 180000
});

app.get('/__health', (_req, res) => {
  res.status(200).type('text/plain').send('OK');
});

app.get('/sw.js', (_req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript; charset=utf-8');
  fs.createReadStream(path.join(ROOT, 'sw.js')).pipe(res);
});

app.get('/runtime-shim.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript; charset=utf-8');
  fs.createReadStream(path.join(ROOT, 'runtime-shim.js')).pipe(res);
});

app.get('/register-sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript; charset=utf-8');
  fs.createReadStream(path.join(ROOT, 'register-sw.js')).pipe(res);
});

function makeUpstreamHeaders(req) {
  const headers = {};
  const allowed = [
    'accept', 'accept-language', 'cache-control', 'pragma', 'range',
    'if-modified-since', 'if-none-match', 'user-agent', 'content-type'
  ];

  for (const name of allowed) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }

  headers.host = TARGET_HOST;
  headers.origin = TARGET_ORIGIN;
  headers.referer = TARGET_ORIGIN + '/play.html';

  // Node側ではHTTP圧縮を要求しない。Unityの.unityweb自体は加工しない。
  headers['accept-encoding'] = 'identity';
  return headers;
}

function encodeHeaderMetadata(headers) {
  const safe = {};
  const allowed = new Set([
    'content-type', 'content-encoding', 'content-language',
    'cache-control', 'etag', 'last-modified', 'expires',
    'accept-ranges', 'content-range', 'vary', 'set-cookie'
  ]);

  for (const [name, value] of Object.entries(headers)) {
    if (!allowed.has(name.toLowerCase()) || value === undefined) continue;
    safe[name.toLowerCase()] = value;
  }

  // Service Workerで安全に復元できるようbase64urlで運ぶ。
  return Buffer.from(JSON.stringify(safe), 'utf8').toString('base64url');
}

// sushida.net固定の転送API。任意ホストには接続できない。
app.all('/_transport/*', (req, res) => {
  const upstreamPath = req.originalUrl.slice('/_transport'.length) || '/';

  if (!upstreamPath.startsWith('/') || upstreamPath.includes('://')) {
    res.status(400).type('text/plain').send('Invalid transport path');
    return;
  }

  const upstreamReq = https.request({
    protocol: 'https:',
    hostname: TARGET_HOST,
    port: 443,
    method: req.method,
    path: upstreamPath,
    headers: makeUpstreamHeaders(req),
    agent,
    timeout: 180000
  }, (upstreamRes) => {
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Proxy-Upstream-Status', String(upstreamRes.statusCode || 502));
    res.setHeader('X-Proxy-Upstream-Status-Text', upstreamRes.statusMessage || '');
    res.setHeader('X-Proxy-Upstream-Headers', encodeHeaderMetadata(upstreamRes.headers));

    // Content-Lengthを付けずchunkedで運び、上流の長さと外側レスポンスを分離する。
    upstreamRes.on('aborted', () => {
      console.error('[transport] upstream aborted:', upstreamPath);
      if (!res.destroyed) res.destroy(new Error('upstream aborted'));
    });
    upstreamRes.on('error', (error) => {
      console.error('[transport] response error:', upstreamPath, error.message);
      if (!res.destroyed) res.destroy(error);
    });
    upstreamRes.pipe(res);
  });

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
  upstreamReq.on('error', (error) => {
    console.error('[transport] request error:', upstreamPath, error.message);
    if (!res.headersSent) {
      res.status(502).type('text/plain; charset=utf-8').send('Upstream request failed');
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  });

  req.pipe(upstreamReq);
});

function fetchHtml(req, res) {
  const upstreamReq = https.request({
    protocol: 'https:',
    hostname: TARGET_HOST,
    port: 443,
    method: 'GET',
    path: req.originalUrl,
    headers: makeUpstreamHeaders(req),
    agent,
    timeout: 120000
  }, (upstreamRes) => {
    const chunks = [];
    upstreamRes.on('data', chunk => chunks.push(chunk));
    upstreamRes.on('end', () => {
      let html = Buffer.concat(chunks).toString('utf8');

      if (req.path === '/play.html') {
        // 初回はSW登録後に再読込。制御済みの場合だけUnityを開始する。
        html = html.replace(/<body\s+onload=["']game\(\)["']>/i, '<body>');
        html = html.replace('</head>', '<script src="/runtime-shim.js"></script>\n<script src="/register-sw.js"></script>\n</head>');
        html = html.replace('</body>', `
<script>
window.__sushidaProxyReady.then(function () {
  try {
    window.__installSushidaUnityRuntimePatch();
    window.gameInstance = UnityLoader.instantiate(
      'gameContainer',
      '/files/v1_3/Web.json',
      { onProgress: UnityProgress }
    );
    var canvas = document.querySelector('#gameContainer canvas');
    if (canvas) canvas.ondragstart = function () { return false; };
  } catch (error) {
    console.error('[proxy boot]', error);
    var container = document.getElementById('gameContainer');
    if (container) container.textContent = 'Unity起動エラー: ' + error.message;
  }
});
</script>
</body>`);
      }

      res.status(upstreamRes.statusCode || 200);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(html);
    });
  });

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('HTML timeout')));
  upstreamReq.on('error', error => {
    console.error('[html]', error.message);
    if (!res.headersSent) res.status(502).type('text/plain').send('sushida.net connection failed');
  });
  upstreamReq.end();
}

app.get(['/', '/play.html'], fetchHtml);

// SWがまだ制御していない初回ページの補助。通常はSWが先に傍受する。
app.use((req, res, next) => {
  if (req.path.startsWith('/_transport/') || req.path === '/sw.js' || req.path === '/register-sw.js' || req.path === '/runtime-shim.js') {
    next();
    return;
  }
  res.redirect(307, '/_transport' + req.originalUrl);
});

const server = app.listen(PORT, () => {
  console.log(`Sushida SW proxy listening on port ${PORT}`);
});

server.setTimeout(180000);
server.requestTimeout = 180000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

function shutdown() {
  server.close(() => {
    agent.destroy();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
