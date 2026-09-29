'use strict';

(function () {
  const ORIGINAL_URL = 'https://keyx0.net/pop/play.html';
  const ORIGINAL_ORIGIN = 'https://keyx0.net';

  // Unity 2017の生成済みframeworkコードが参照するURLを、元サイトとして扱わせる。
  function patchFrameworkSource(source) {
    return source
      .replace(/window\.location\.href/g, JSON.stringify(ORIGINAL_URL))
      .replace(/document\.location\.href/g, JSON.stringify(ORIGINAL_URL))
      .replace(/document\.URL/g, JSON.stringify(ORIGINAL_URL))
      .replace(/document\.documentURI/g, JSON.stringify(ORIGINAL_URL))
      .replace(/location\.origin/g, JSON.stringify(ORIGINAL_ORIGIN));
  }

  window.__installSushidaUnityRuntimePatch = function () {
    if (!window.UnityLoader || window.UnityLoader.__sushidaPatched) return;

    const originalLoadCode = window.UnityLoader.loadCode;
    window.UnityLoader.loadCode = function (code, onload, metadata) {
      try {
        const url = metadata && metadata.url ? String(metadata.url) : '';
        const isFramework = /framework/i.test(url);
        if (isFramework && (code instanceof Uint8Array || code instanceof ArrayBuffer)) {
          const bytes = code instanceof Uint8Array ? code : new Uint8Array(code);
          const decoded = new TextDecoder('utf-8').decode(bytes);
          const patched = patchFrameworkSource(decoded);
          if (patched !== decoded) {
            console.log('[Sushida proxy] patched Unity framework URL environment');
            code = new TextEncoder().encode(patched);
          }
        }
      } catch (error) {
        console.warn('[Sushida proxy] framework patch skipped', error);
      }
      return originalLoadCode.call(this, code, onload, metadata);
    };

    window.UnityLoader.__sushidaPatched = true;
  };

  // 可能な範囲でDocument由来のURLも元サイトに合わせる。
  for (const [key, value] of [
    ['URL', ORIGINAL_URL],
    ['documentURI', ORIGINAL_URL],
    ['referrer', ORIGINAL_ORIGIN + '/pop/']
  ]) {
    try {
      Object.defineProperty(document, key, {
        configurable: true,
        get: () => value
      });
    } catch (_) {}
  }

  // AudioContextがユーザー操作待ちの場合、最初の操作で確実に再開する。
  const resumeAudio = () => {
    const contexts = window.__sushidaAudioContexts || [];
    for (const context of contexts) {
      if (context && context.state === 'suspended') context.resume().catch(() => {});
    }
  };

  window.__sushidaAudioContexts = [];
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Native = window[name];
    if (!Native || Native.__sushidaWrapped) continue;
    function WrappedAudioContext(...args) {
      const context = new Native(...args);
      window.__sushidaAudioContexts.push(context);
      return context;
    }
    WrappedAudioContext.prototype = Native.prototype;
    Object.setPrototypeOf(WrappedAudioContext, Native);
    WrappedAudioContext.__sushidaWrapped = true;
    window[name] = WrappedAudioContext;
  }

  for (const eventName of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(eventName, resumeAudio, { passive: true });
  }
})();
