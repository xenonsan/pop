'use strict';

window.__sushidaProxyReady = (async () => {
  if (!('serviceWorker' in navigator)) {
    throw new Error('このブラウザはService Workerに対応していません');
  }

  await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none'
  });
  await navigator.serviceWorker.ready;

  if (!navigator.serviceWorker.controller) {
    sessionStorage.setItem('sushida-sw-reload', '1');
    location.reload();
    return new Promise(() => {});
  }

  sessionStorage.removeItem('sushida-sw-reload');
  return true;
})();
