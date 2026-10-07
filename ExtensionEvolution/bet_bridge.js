// bet_bridge.js - PragmaticBot Evolution 베팅 중계기 (ISOLATED world)
// ----------------------------------------------------------------------------
// 역할: 봇(C# 서버)이 보낸 EVO_SEND_BET(평문 베팅 명령)을 받아 페이지의 bet_send.js 로 넘기고,
//       그 결과를 봇으로 돌려준다.
// 독립성: 기존 content.js 와 별개의 연결을 쓴다(서버는 다중 연결 허용). 기존 파일은 건드리지 않는다.
// 주의: 봇 서버는 source:'evolution' 로 알린 연결을 "수신 전용"으로 분류해 기존 SEND_BET(프라그마틱)
//       명령 채널에서 제외한다. 그래서 두 익스텐션 명령이 서로 섞이지 않는다.
(function () {
    'use strict';

    var BASE_PORT = 29876, MAX_ATTEMPTS = 5;
    var socket = null, reconnectTimer = null, lastPort = BASE_PORT;

    function connect() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        tryPort(lastPort, 0);
    }
    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 5000);
    }
    function tryPort(port, attempt) {
        if (attempt >= MAX_ATTEMPTS) { scheduleReconnect(); return; }
        var p = BASE_PORT + ((port - BASE_PORT + attempt) % MAX_ATTEMPTS);
        try {
            var ws = new WebSocket('ws://127.0.0.1:' + p);   // IPv4 고정
            var settled = false;
            ws.onopen = function () {
                if (settled) return;
                settled = true;
                socket = ws; lastPort = p;
                try {
                    socket.send(JSON.stringify({
                        type: 'EXTENSION_CONNECTED', url: location.href,
                        source: 'evolution', role: 'bet-bridge'
                    }));
                } catch (e) {}
                console.log('[EVOBET Bridge] 봇 연결됨 (포트 ' + p + ')');
            };
            ws.onclose = function () {
                if (!settled) { settled = true; tryPort(port, attempt + 1); return; }
                socket = null; scheduleReconnect();
            };
            ws.onerror = function () { /* onclose 에서 다음 포트 시도 */ };
            ws.onmessage = function (event) {
                var d;
                try { d = JSON.parse(event.data); } catch (e) { return; }
                if (!d || d.type !== 'EVO_SEND_BET') return;      // 이 채널은 베팅 명령만 처리
                window.postMessage({
                    type: 'EVOBET_SEND', id: d.id, tableId: d.tableId, message: d.message
                }, '*');
            };
        } catch (e) {
            tryPort(port, attempt + 1);
        }
    }

    // 페이지(bet_send.js) → 봇: 전송 결과 회신
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        var d = event.data;
        if (!d || d.type !== 'EVOBET_RESULT') return;
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify({
                    type: 'EVO_BET_RESULT', id: d.id, ok: !!d.ok, status: d.status || ''
                }));
            } catch (e) {}
        }
    });

    connect();
    console.log('[EVOBET Bridge] 초기화 완료');
})();
