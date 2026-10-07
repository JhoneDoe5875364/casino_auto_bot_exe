// content.js - PragmaticBot: Extension과 페이지 간 브릿지
// Phase 1: 모든 WebSocket 메시지를 C# 서버로 릴레이
(function() {
    'use strict';

    console.log('[PragmaticBot Content] 시작');

    let pragmaticbotSocket = null;
    let isConnected = false;
    let reconnectTimer = null;

    // 포트 폴백: C# 서버(PragmaticWebSocketServer)와 동일하게 29876~29880 순차 시도
    const BASE_PORT = 29876;
    const MAX_PORT_ATTEMPTS = 5;
    let lastConnectedPort = BASE_PORT; // 마지막 성공 포트 기억

    // 이 iframe에서 게임 WebSocket이 캡처되었는지 여부
    let hasGameWebSocket = false;
    let capturedWsUrl = '';

    function connectToPragmaticBot() {
        if (pragmaticbotSocket && pragmaticbotSocket.readyState === WebSocket.OPEN) {
            return;
        }

        // 마지막 성공 포트부터 시도, 실패 시 나머지 포트 순회
        tryConnectPort(lastConnectedPort, 0);
    }

    function tryConnectPort(port, attempt) {
        if (attempt >= MAX_PORT_ATTEMPTS) {
            console.log('[PragmaticBot Content] 모든 포트(29876~29880) 연결 실패, 5초 후 재시도');
            if (!reconnectTimer) {
                reconnectTimer = setTimeout(function() {
                    reconnectTimer = null;
                    connectToPragmaticBot();
                }, 5000);
            }
            return;
        }

        // 포트 범위 순환: lastConnectedPort부터 시작해 29876~29880 범위 내 순회
        var tryPort = BASE_PORT + ((port - BASE_PORT + attempt) % MAX_PORT_ATTEMPTS);
        console.log('[PragmaticBot Content] 포트 ' + tryPort + ' 연결 시도... (' + (attempt + 1) + '/' + MAX_PORT_ATTEMPTS + ')');

        try {
            // IPv4 고정: 'localhost'가 IPv6(::1)로 resolve되면 Fleck(127.0.0.1 바인딩)과 연결 실패
            var ws = new WebSocket('ws://127.0.0.1:' + tryPort);
            var settled = false; // 이 시도의 성공/실패 결정 여부

            ws.onopen = function() {
                if (settled) return;
                settled = true;

                pragmaticbotSocket = ws;
                lastConnectedPort = tryPort;
                isConnected = true;
                console.log('[PragmaticBot Content] PragmaticBot 서버 연결됨 (포트 ' + tryPort + ')');

                pragmaticbotSocket.send(JSON.stringify({
                    type: 'EXTENSION_CONNECTED',
                    url: window.location.href
                }));

                // 재연결 시 WS_CAPTURED 재전송
                if (hasGameWebSocket && capturedWsUrl) {
                    pragmaticbotSocket.send(JSON.stringify({
                        type: 'WS_CAPTURED',
                        url: capturedWsUrl
                    }));
                }
            };

            ws.onmessage = function(event) {
                try {
                    const data = JSON.parse(event.data);

                    if (data.type === 'SEND_BET') {
                        if (hasGameWebSocket) {
                            window.postMessage({
                                type: 'PRAGMATICBOT_SEND_BET',
                                message: data.message
                            }, '*');
                        }
                    }

                    if (data.type === 'REFRESH_GAME') {
                        console.log('[PragmaticBot Content] 새로고침 명령 수신');
                        window.location.reload();
                    }

                    if (data.type === 'DOMAIN_CONFIG') {
                        console.log('[PragmaticBot Content] 도메인 설정 수신:', data.domains);
                        window.postMessage({
                            type: 'PRAGMATICBOT_DOMAIN_CONFIG',
                            domains: data.domains
                        }, '*');
                    }

                    if (data.type === 'WS_RELEASE') {
                        hasGameWebSocket = false;
                        capturedWsUrl = '';
                        window.postMessage({ type: 'PRAGMATICBOT_WS_RELEASE' }, '*');
                    }

                    // ★ 3순위: 베팅 전후 DOM 스냅샷 명령 릴레이
                    if (data.type === 'SNAPSHOT_BEFORE_BET') {
                        window.postMessage({ type: 'PRAGMATICBOT_SNAPSHOT_BEFORE_BET' }, '*');
                    }
                    if (data.type === 'SNAPSHOT_AFTER_BET') {
                        window.postMessage({
                            type: 'PRAGMATICBOT_SNAPSHOT_AFTER_BET',
                            betAmount: data.betAmount
                        }, '*');
                    }

                    // ★ PP wallet/balance API 강제 호출 명령
                    if (data.type === 'FETCH_BALANCE') {
                        window.postMessage({ type: 'PRAGMATICBOT_FETCH_BALANCE' }, '*');
                    }
                } catch (e) {
                    // JSON 파싱 실패 무시
                }
            };

            ws.onclose = function() {
                if (!settled) {
                    // 연결 성공 전 닫힘 → 다음 포트 시도
                    settled = true;
                    tryConnectPort(port, attempt + 1);
                    return;
                }

                // 연결 성공 후 끊김 → 재연결
                console.log('[PragmaticBot Content] PragmaticBot 서버 연결 끊김');
                isConnected = false;

                if (!reconnectTimer) {
                    reconnectTimer = setTimeout(function() {
                        reconnectTimer = null;
                        connectToPragmaticBot();
                    }, 5000);
                }
            };

            ws.onerror = function(error) {
                if (!settled) {
                    // 연결 실패 → onclose에서 다음 포트 시도
                    return;
                }
                console.log('[PragmaticBot Content] WebSocket 에러:', error);
            };

        } catch (e) {
            console.log('[PragmaticBot Content] 포트 ' + tryPort + ' 연결 실패:', e);
            tryConnectPort(port, attempt + 1);
        }
    }

    // 페이지에서 메시지 수신
    window.addEventListener('message', function(event) {
        if (event.source !== window) return;

        // WebSocket 캡처 알림
        if (event.data.type === 'PRAGMATICBOT_WS_CAPTURED') {
            console.log('[PragmaticBot Content] 게임 WebSocket 캡처됨:', event.data.url);
            hasGameWebSocket = true;
            capturedWsUrl = event.data.url || '';

            if (pragmaticbotSocket && pragmaticbotSocket.readyState === WebSocket.OPEN) {
                pragmaticbotSocket.send(JSON.stringify({
                    type: 'WS_CAPTURED',
                    url: event.data.url
                }));
            }
        }

        // ★ Phase 1: 모든 WebSocket 메시지를 서버로 릴레이 (캡처/분석용)
        if (event.data.type === 'PRAGMATICBOT_WS_MESSAGE') {
            if (hasGameWebSocket) {
                if (pragmaticbotSocket && pragmaticbotSocket.readyState === WebSocket.OPEN) {
                    pragmaticbotSocket.send(JSON.stringify({
                        type: 'WS_MESSAGE',
                        direction: event.data.direction,
                        url: event.data.url,
                        data: event.data.data
                    }));
                } else {
                    console.log('[PragmaticBot Content] 서버 소켓 미연결 - 메시지 드롭',
                        pragmaticbotSocket?.readyState);
                }
            } else {
                console.log('[PragmaticBot Content] hasGameWebSocket=false - 메시지 드롭');
            }
        }

        // ★ HTTP 응답 잔액 업데이트 릴레이
        if (event.data.type === 'PRAGMATICBOT_HTTP_BALANCE_UPDATE') {
            if (pragmaticbotSocket && pragmaticbotSocket.readyState === WebSocket.OPEN) {
                pragmaticbotSocket.send(JSON.stringify({
                    type: 'HTTP_BALANCE_UPDATE',
                    balance: event.data.balance,
                    url: event.data.url
                }));
            }
        }

        // ★ DOM 잔액 업데이트 릴레이
        if (event.data.type === 'PRAGMATICBOT_BALANCE_UPDATE') {
            if (pragmaticbotSocket && pragmaticbotSocket.readyState === WebSocket.OPEN) {
                pragmaticbotSocket.send(JSON.stringify({
                    type: 'BALANCE_UPDATE',
                    balance: event.data.balance
                }));
            }
        }

        // 베팅 전송 결과
        if (event.data.type === 'PRAGMATICBOT_SEND_RESULT') {
            if (hasGameWebSocket) {
                if (pragmaticbotSocket && pragmaticbotSocket.readyState === WebSocket.OPEN) {
                    pragmaticbotSocket.send(JSON.stringify({
                        type: 'BET_RESULT',
                        success: event.data.success,
                        error: event.data.error
                    }));
                }
            }
        }

        // ★ 3순위: DOM 차이로 감지된 잔액 셀렉터 릴레이
        if (event.data.type === 'PRAGMATICBOT_BALANCE_SELECTOR_DETECTED') {
            if (pragmaticbotSocket && pragmaticbotSocket.readyState === WebSocket.OPEN) {
                pragmaticbotSocket.send(JSON.stringify({
                    type: 'BALANCE_SELECTOR_DETECTED',
                    selector: event.data.selector,
                    balance: event.data.balance
                }));
            }
        }
    });

    // Keep-Alive (30초 간격)
    setInterval(function() {
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            clientX: Math.floor(Math.random() * window.innerWidth),
            clientY: Math.floor(Math.random() * window.innerHeight)
        }));
    }, 30000);

    // PragmaticBot 서버에 연결
    connectToPragmaticBot();

    console.log('[PragmaticBot Content] 초기화 완료');
})();
