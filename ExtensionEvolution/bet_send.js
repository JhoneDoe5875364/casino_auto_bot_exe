// bet_send.js - PragmaticBot Evolution 베팅 송신기 (MAIN world)
// ----------------------------------------------------------------------------
// 역할: 봇이 보낸 "평문" 베팅 명령을 받아, 그 테이블을 담당하는 게임 소켓으로 전송한다.
//       소켓 주소에 nonce가 있으면(암호화 사이트) Evolution 방식(RC4)으로 암호화해서 보내고,
//       없으면 평문 그대로 보낸다.
// 독립성: 기존 inject.js / content.js 는 건드리지 않는다. 네임스페이스는 EVOBET_* 로 분리.
//       기존 PragmaticBot(PP) 익스텐션의 __pragmaticbot_* 와도 겹치지 않는다.
// 안전: WebSocket 후킹은 원본을 항상 호출하며 실패해도 게임 동작에 영향이 없다.
(function () {
    'use strict';
    if (window.__evobet_send_hooked) return;
    window.__evobet_send_hooked = true;

    var RC4_SALT = '560a7047c677ab04d413e1f19a19fb517a9e53eeea5ae2f265e8d432131b4192';
    var sockets = [];                 // 이 프레임에서 열린 게임 소켓들

    // ---------- RC4 (Evolution EncryptionService 와 동일) ----------
    function rc4Init(key) {
        var S = new Uint8Array(256), i, j = 0, t;
        for (i = 0; i < 256; i++) S[i] = i;
        for (i = 0; i < 256; i++) {
            j = (j + S[i] + key[i % key.length]) & 255;
            t = S[i]; S[i] = S[j]; S[j] = t;
        }
        return S;
    }
    function rc4Process(state, data) {
        // 메시지마다 키 흐름을 처음부터 다시 시작한다(클라이언트와 동일). 상태를 이어 쓰면
        // 첫 프레임 이후가 전부 깨진다.
        var S = state.slice(), i = 0, j = 0, t, out = new Uint8Array(data.length);
        for (var n = 0; n < data.length; n++) {
            i = (i + 1) & 255; j = (j + S[i]) & 255;
            t = S[i]; S[i] = S[j]; S[j] = t;
            out[n] = data[n] ^ S[(S[i] + S[j]) & 255];
        }
        return out;
    }
    function makeCrypto(url) {
        try {
            var qs = String(url || '').split('?')[1] || '', q = {};
            qs.split('&').forEach(function (kv) {
                // 첫 '=' 에서만 자른다. nonce 는 base64 라 '==' 패딩이 값의 일부다.
                var eq = kv.indexOf('=');
                if (eq <= 0) return;
                q[decodeURIComponent(kv.slice(0, eq))] = decodeURIComponent(kv.slice(eq + 1).replace(/\+/g, ' '));
            });
            if (!q.nonce || !q.instance) return null;      // 평문 소켓
            var state = rc4Init(new TextEncoder().encode(RC4_SALT + ':' + q.instance + ':' + q.nonce));
            return {
                encrypt: function (text) {
                    var body = new TextEncoder().encode(text);
                    var payload = new Uint8Array(body.length + 1);
                    payload[0] = 0;                        // 압축 안 함
                    payload.set(body, 1);
                    var enc = rc4Process(state, payload);
                    var frame = new Uint8Array(enc.length + 2);
                    frame[0] = 1; frame[1] = 3;            // 버전 1, RC4 + 압축칸
                    frame.set(enc, 2);
                    return frame;
                },
                decrypt: function (buf) {
                    var f = new Uint8Array(buf);
                    if (f.length < 2 || f[0] !== 1 || (f[1] !== 1 && f[1] !== 3)) return null;
                    var data = rc4Process(state, f.subarray(2));
                    if (f[1] === 3) {
                        if (data[0] === 1) return null;    // zstd 본문은 페이지가 푼다
                        data = data.subarray(1);
                    }
                    return new TextDecoder().decode(data);
                }
            };
        } catch (e) { return null; }
    }

    // ---------- 소켓 추적 + 테이블 꼬리표 ----------
    function scanTables(ws, text) {
        var i = text.indexOf('"tableId":"');
        while (i >= 0) {
            var s = i + 11, e = text.indexOf('"', s);
            if (e < 0) break;
            ws.__evobetTables[text.slice(s, e)] = 1;
            i = text.indexOf('"tableId":"', e);
        }
    }
    function watch(ws) {
        if (!ws || ws.__evobetTables) return;
        try {
            ws.__evobetTables = {};
            ws.__evobetCrypto = makeCrypto(ws.url);
        } catch (e) { return; }
        if (sockets.indexOf(ws) < 0) sockets.push(ws);
        try {
            ws.addEventListener('message', function (ev) {
                var d = ev && ev.data;
                if (typeof d === 'string') { if (d.length < 200000) scanTables(ws, d); return; }
                if (ws.__evobetCrypto && d && d.byteLength && d.byteLength < 200000) {
                    try { var t = ws.__evobetCrypto.decrypt(d); if (t) scanTables(ws, t); } catch (e) {}
                }
            });
        } catch (e) {}
    }
    try {
        var Native = window.WebSocket;
        var Wrapped = function (url, protocols) {
            var ws = (protocols === undefined) ? new Native(url) : new Native(url, protocols);
            try { watch(ws); } catch (e) {}
            return ws;
        };
        Wrapped.prototype = Native.prototype;
        Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSING = 2; Wrapped.CLOSED = 3;
        window.WebSocket = Wrapped;
    } catch (e) {}

    // ---------- 봇 명령 처리 ----------
    var seen = {};                     // 같은 명령을 두 번 보내지 않기 위한 기록
    function pick(tableId) {
        var open = sockets.filter(function (w) { return w && w.readyState === 1; });
        for (var i = 0; i < open.length; i++) {
            if (tableId && open[i].__evobetTables && open[i].__evobetTables[tableId]) return open[i];
        }
        return null;                   // 담당 소켓을 못 찾으면 보내지 않는다(엉뚱한 소켓 방지)
    }
    function reply(id, ok, status) {
        try { window.postMessage({ type: 'EVOBET_RESULT', id: id, ok: ok, status: status }, '*'); } catch (e) {}
    }
    // 실제 전송 한 곳. 릴레이(EVOBET_SEND)와 CDP 직접호출(__evobetSend)이 공유한다.
    function sendCore(tableId, message, id) {
        try {
            if (id && seen[id]) return 'dup-skip';
            var ws = pick(tableId);
            if (!ws) return 'no-socket';
            var enc = ws.__evobetCrypto ? ws.__evobetCrypto.encrypt(message) : null;
            ws.send(enc || message);
            if (id) { seen[id] = 1; setTimeout(function () { delete seen[id]; }, 60000); }
            return enc ? 'sent+enc' : 'sent';
        } catch (e) {
            return 'error:' + (e && e.message ? e.message : e);
        }
    }

    // (1) 릴레이 경로: 봇 → bet_bridge(ws) → 여기. 릴레이가 막힌 환경에서는 도달하지 않는다.
    window.addEventListener('message', function (ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.type !== 'EVOBET_SEND') return;
        var status = sendCore(d.tableId, d.message, d.id || '');
        reply(d.id || '', status.indexOf('sent') === 0, status);
    });

    // (2) CDP 직접호출 경로: 봇이 Runtime.evaluate 로 이 함수를 부른다. 릴레이 차단과 무관하게
    //     동작한다(봇→Chrome 방향). 결과를 즉시 반환하므로 회신 채널이 따로 필요 없다.
    window.__evobetSend = function (tableId, message, id) {
        return sendCore(tableId, message, id || '');
    };

    console.log('[EVOBET] bet_send.js 로드됨 (frame=' + (window.top === window ? 'TOP' : 'child') + ')');
})();
