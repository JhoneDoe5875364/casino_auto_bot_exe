// content.js - PragmaticBot Evolution Connector (bridge, ISOLATED world)
// ----------------------------------------------------------------------------
// 역할: inject.js가 얻은 Evolution 게임 평문(EVOBOT_GAME_PLAINTEXT)을 C# 서버
//       (PragmaticWebSocketServer, 127.0.0.1:29876~29880)로 릴레이한다. 서버는 이를 WS_MESSAGE(receive)로
//       받아 파서(Evolution 라우팅) + 잔액 자동추출을 수행한다.
// 베팅: 익스텐션은 데이터 전달만 담당한다(봇→익스텐션 명령/송신 로직 없음). 실제 베팅은 봇의 DOM 자동화(CDP).
// 독립성: 기존 Pragmatic content.js와 별개의 소켓으로 연결한다(서버는 다중 연결 허용).
(function () {
    'use strict';

    console.log('[EVOBOT Content] 시작');

    let socket = null;
    let reconnectTimer = null;

    // C# 서버와 동일하게 29876~29880 순차 시도. (멀티사이트 런처가 이 상수를 슬롯별 포트로 치환)
    const BASE_PORT = 29876;
    const MAX_PORT_ATTEMPTS = 5;
    let lastConnectedPort = BASE_PORT;

    function connect() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        tryPort(lastConnectedPort, 0);
    }

    function tryPort(port, attempt) {
        if (attempt >= MAX_PORT_ATTEMPTS) {
            if (!reconnectTimer) {
                reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 5000);
            }
            return;
        }
        var p = BASE_PORT + ((port - BASE_PORT + attempt) % MAX_PORT_ATTEMPTS);
        try {
            // IPv4 고정: localhost가 IPv6(::1)로 resolve되면 Fleck(127.0.0.1)과 연결 실패
            var ws = new WebSocket('ws://127.0.0.1:' + p);
            var settled = false;
            ws.onopen = function () {
                if (settled) return;
                settled = true;
                socket = ws;
                lastConnectedPort = p;
                console.log('[EVOBOT Content] 서버 연결됨 (포트 ' + p + ')');
                try {
                    socket.send(JSON.stringify({ type: 'EXTENSION_CONNECTED', url: window.location.href, source: 'evolution' }));
                } catch (e) {}
            };
            ws.onclose = function () {
                if (!settled) { settled = true; tryPort(port, attempt + 1); return; }
                console.log('[EVOBOT Content] 서버 연결 끊김');
                if (!reconnectTimer) {
                    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 5000);
                }
            };
            ws.onerror = function () { /* onclose에서 다음 포트 시도 */ };
        } catch (e) {
            tryPort(port, attempt + 1);
        }
    }

    // 페이지(inject.js)에서 복호화 평문 수신 → 서버로 릴레이
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        var d = event.data;
        if (!d || d.type !== 'EVOBOT_GAME_PLAINTEXT') return;
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify({
                    type: 'WS_MESSAGE',
                    direction: 'receive',
                    url: d.url || window.location.href,
                    data: d.data
                }));
            } catch (e) {}
        }
    });

    connect();
    console.log('[EVOBOT Content] 초기화 완료');
})();
