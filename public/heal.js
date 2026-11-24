// 같은 출처 스크립트·스타일이 못 뜨면 한 번만 그 파일들을 캐시에서 버리고 다시 받아 새로 연다.
// 2026-11-24: social.txid.uk 가 배포 직후 엣지에 잘못 물린 스크립트(HTML)로 멈췄다 — 함대 공통 장치.
// 판정은 앱마다 다른 «떴다» 신호 대신 실패 자체: 요소 로드 오류(형식 불일치·404), HTML 을 JS 로 읽은
// 구문 오류, 지연 로딩 모듈 실패. 서비스 워커 캐시는 통째로 지우지 않고 그 주소들만 뺀다(오프라인 데이터 보존).
// 🔴 <head> 맨 앞, async·defer 없이 — 뒤에 오는 자원의 오류를 잡으려면 먼저 떠 있어야 한다.
// 한 탭 세션에 한 번만(sessionStorage) — 서버가 정말 깨졌으면 되풀이하지 않는다.
(function () {
  var KEY = 'txidHeal';
  var ASSET = /\.(m?js|css)(\?|#|$)/;
  var bad = [];
  var timer = 0;
  var same = function (u) { return typeof u === 'string' && u.indexOf(location.origin + '/') === 0; };

  function heal(url) {
    if (same(url) && bad.indexOf(url) < 0) bad.push(url);
    if (timer) return;
    try { if (sessionStorage.getItem(KEY)) return; sessionStorage.setItem(KEY, '1'); } catch { return; }
    // 한 번에 여러 파일이 깨지므로 잠깐 모았다가 한꺼번에.
    timer = setTimeout(function () {
      var urls = bad.concat(
        [].map.call(document.querySelectorAll('script[src],link[rel=stylesheet],link[rel=modulepreload]'), function (el) { return el.src || el.href; }),
        performance.getEntriesByType('resource').map(function (e) { return e.name; })
      ).filter(function (u, i, a) { return same(u) && ASSET.test(u) && a.indexOf(u) === i; });
      var purge = window.caches
        ? caches.keys().then(function (ks) {
          return Promise.all(ks.map(function (k) {
            return caches.open(k).then(function (c) { return Promise.all(urls.map(function (u) { return c.delete(u, { ignoreSearch: false }); })); });
          }));
        }).catch(function () { return null; })
        : Promise.resolve();
      purge
        .then(function () { return Promise.all(urls.map(function (u) { return fetch(u, { cache: 'reload', credentials: 'same-origin' }).catch(function () { return null; }); })); })
        .then(function () { location.reload(); });
    }, 300);
  }

  addEventListener('error', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK') && ASSET.test(t.src || t.href || '')) {
      if (same(t.src || t.href)) heal(t.src || t.href);
      return;
    }
    // nosniff 가 없어 HTML 이 스크립트로 읽힌 경우
    if (e.message && same(e.filename) && /Unexpected token '?<|expected expression, got '<'/.test(e.message)) heal(e.filename);
  }, true);

  // Chromium 은 형식이 틀린 스타일시트에 error 를 안 쏘고 조용히 버린다(sheet 가 null).
  addEventListener('load', function () {
    [].forEach.call(document.querySelectorAll('link[rel=stylesheet]'), function (l) {
      if (!l.sheet && !l.disabled && same(l.href) && ASSET.test(l.href)) heal(l.href);
    });
  });

  addEventListener('vite:preloadError', function () { heal(''); });
  addEventListener('unhandledrejection', function (e) {
    var m = String((e.reason && e.reason.message) || e.reason || '');
    if (/dynamically imported module|Importing a module script failed|ChunkLoadError|Loading (CSS )?chunk .* failed|Unable to preload CSS/.test(m)) heal('');
  });
})();
