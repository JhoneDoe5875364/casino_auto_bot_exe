// inject.js - PragmaticBot Evolution Connector (MAIN world)
// ----------------------------------------------------------------------------
// 역할: Evolution 라이브 바카라의 게임 평문(baccarat.* / balanceUpdated)을 "복호화 직후" 지점
//       (JSON.parse / TextDecoder.decode)에서 잡아 content.js로 전달한다. content.js가 C# 서버로
//       릴레이하면 파서의 Evolution 라우팅이 처리한다.
// 베팅: 익스텐션은 데이터 전달만 담당한다. 실제 베팅은 봇의 DOM 자동화(CDP 신뢰 클릭)가 수행하므로
//       이 파일에는 송신/암호화/베팅 로직이 전혀 없다.
// 독립성: 기존 Pragmatic 익스텐션과 겹치지 않도록 EVOBOT_* 네임스페이스 사용. WebSocket/fetch/XHR은
//       건드리지 않고 JSON.parse/TextDecoder만 후킹한다.
// 안전: 모든 후킹 try/catch + 원본 항상 호출 → 게임 동작에 영향 없음.
(function () {
    'use strict';
    if (window.__evobot_hooked) return;
    window.__evobot_hooked = true;

    // 게임 평문 전달 대상 (부분 문자열 매칭): baccarat.* + balanceUpdated 만.
    var GAME_FWD = ['"type":"baccarat.', '"type":"balanceUpdated"'];
    var _fwdLast = '';
    function forwardGame(s) {
        try {
            if (typeof s !== 'string' || s === _fwdLast) return;
            for (var i = 0; i < GAME_FWD.length; i++) {
                if (s.indexOf(GAME_FWD[i]) !== -1) {
                    _fwdLast = s;
                    // (1) 릴레이 경로: content.js 가 ws://127.0.0.1 로 봇에 전달. 릴레이가 막힌 환경에선 도달 안 함.
                    window.postMessage({ type: 'EVOBOT_GAME_PLAINTEXT', url: location.href, data: s }, '*');
                    // (2) CDP 직접수신 경로: 봇이 Runtime.evaluate 로 이 큐를 비워 가져간다. 릴레이 차단과 무관.
                    //     게임 평문은 자식 프레임에서 생긴다. 봇 CDP 는 타겟의 기본(top) 컨텍스트로 접근하므로,
                    //     "접근 가능한 최상위 동일오리진 조상"에 큐를 모아야 한 곳에서 다 꺼낼 수 있다.
                    try {
                        var w = window;
                        // 크로스오리진 경계 전까지 올라간다(경계에서 접근하면 throw → 직전 것을 쓴다).
                        try {
                            while (w.parent && w.parent !== w) {
                                var probe = w.parent.location.href;  // 접근되면 동일오리진
                                w = w.parent;
                            }
                        } catch (e) { /* w 는 접근 가능한 최상위 */ }
                        var q = w.__evoRxQueue || (w.__evoRxQueue = []);
                        q.push(s);
                        if (q.length > 800) q.splice(0, q.length - 800);
                    } catch (e) {
                        try { var q2 = window.__evoRxQueue || (window.__evoRxQueue = []); q2.push(s); if (q2.length > 800) q2.splice(0, q2.length - 800); } catch (e2) {}
                    }
                    return;
                }
            }
        } catch (e) {}
    }

    // ---- 후킹 1: JSON.parse (페이지가 복호화해 파싱하는 평문) ----
    var _parse = JSON.parse;
    JSON.parse = function (text) {
        var r = _parse.apply(this, arguments);
        try {
            if (typeof text === 'string' && text.length >= 5) {
                var i = 0;
                while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r')) i++;
                var ch = text[i];
                if (ch === '{' || ch === '[') forwardGame(text);
            }
        } catch (e) {}
        return r;
    };

    // ---- 후킹 2: TextDecoder.decode ----
    try {
        var _dec = TextDecoder.prototype.decode;
        TextDecoder.prototype.decode = function () {
            var out = _dec.apply(this, arguments);
            try {
                if (typeof out === 'string' && out.length >= 5) {
                    var t = out.charAt(0) <= ' ' ? out.replace(/^\s+/, '') : out;
                    var ch = t.charAt(0);
                    if (ch === '{' || ch === '[') forwardGame(out);
                }
            } catch (e) {}
            return out;
        };
    } catch (e) {}

    console.log('[EVOBOT] inject.js 로드됨 (frame=' + (window.top === window ? 'TOP' : 'child') + ') — 데이터 전달 전용');
})();
