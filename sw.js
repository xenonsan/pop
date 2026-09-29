'use strict';

const VERSION = 'sushida-proxy-sw-v3-pop';
const BASE_PATH = '/pop';
const BYPASS = new Set([
  BASE_PATH + '/sw.js',
  BASE_PATH + '/register-sw.js',
  BASE_PATH + '/runtime-shim.js',
  BASE_PATH + '/__health'
]);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

function decodeMetadata(value) {
  if (!value) return {};
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    console.error('[SW] header metadata decode failed', error);
    return {};
  }
}

function reconstructHeaders(transportResponse) {
  const original = decodeMetadata(
    transportResponse.headers.get('x-proxy-upstream-headers')
  );
  const headers = new Headers();

  for (const [name, value] of Object.entries(original)) {
    const lower = name.toLowerCase();
    if ([
      'content-length', 'transfer-encoding', 'connection',
      'content-security-policy', 'content-security-policy-report-only',
      'x-frame-options'
    ].includes(lower)) continue;

    if (lower === 'set-cookie') continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else {
      headers.set(name, String(value));
    }
  }

  headers.set('x-sushida-proxy-sw', VERSION);
  return headers;
}

async function proxyRequest(request) {
  const url = new URL(request.url);
  const upstreamPath = url.pathname.slice(BASE_PATH.length) || '/';
  const transportUrl = BASE_PATH + '/_transport' + upstreamPath + url.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.delete('connection');

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
    cache: 'no-store',
    credentials: 'same-origin'
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
    init.duplex = 'half';
  }

  const transport = await fetch(transportUrl, init);
  if (!transport.ok) return transport;

  const status = Number(transport.headers.get('x-proxy-upstream-status')) || 502;
  const statusText = transport.headers.get('x-proxy-upstream-status-text') || '';
  const responseHeaders = reconstructHeaders(transport);

  // bodyをarrayBuffer化せずストリームのままUnityLoaderへ渡す。
  return new Response(request.method === 'HEAD' ? null : transport.body, {
    status,
    statusText,
    headers: responseHeaders
  });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE_PATH + '/')) return;

  // ドキュメントは必ずserver.jsを通し、起動パッチの注入を維持する。
  if (event.request.mode === 'navigate' || event.request.destination === 'document') return;
  if (url.pathname.startsWith(BASE_PATH + '/_transport/') || BYPASS.has(url.pathname)) return;

  event.respondWith(
    proxyRequest(event.request).catch(error => {
      console.error('[SW] proxy failure', url.pathname, error);
      return new Response('Proxy transport failed: ' + error.message, {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      });
    })
  );
});
