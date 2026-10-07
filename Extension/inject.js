// inject.js - PragmaticBot: 페이지 컨텍스트에서 모든 WebSocket 트래픽 캡처
// Phase 1: 프로토콜 분석을 위한 전체 메시지 캡처
(function () {
    'use strict';

    // 이미 후킹된 경우 중복 방지
    if (window.__pragmaticbot_hooked) return;
    window.__pragmaticbot_hooked = true;

    console.log('[PragmaticBot] inject.js v2 로드됨 - ' + window.location.href);

    // 원본 WebSocket 저장
    const OriginalWebSocket = window.WebSocket;

    // 캡처된 WebSocket 목록
    window.__pragmaticbot_websockets = [];

    // 게임 도메인 목록 (DOMAIN_CONFIG 수신 후 설정)
    let gameDomains = [];

    // 도메인 설정 전 생성된 WebSocket 추적
    let allCreatedWebSockets = [];

    // 도메인 설정 수신 리스너
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        if (event.data.type === 'PRAGMATICBOT_DOMAIN_CONFIG') {
            gameDomains = Array.isArray(event.data.domains) ? event.data.domains : [];
            console.log('[PragmaticBot] 도메인 설정 수신:', gameDomains);
            console.log('[PragmaticBot] 현재 추적 중인 WebSocket 수:', allCreatedWebSockets.length);
            allCreatedWebSockets.forEach(function (entry) {
                console.log('[PragmaticBot] 추적 중:', entry.url, 'readyState:', entry.ws.readyState);
            });

            // 소급 캡처 (도메인 필터 유무와 관계없이)
            allCreatedWebSockets = allCreatedWebSockets.filter(function (entry) {
                return entry.ws.readyState !== WebSocket.CLOSED;
            });

            allCreatedWebSockets.forEach(function (entry) {
                if (matchesGameDomain(entry.url) &&
                    entry.ws.readyState !== WebSocket.CLOSED &&
                    !window.__pragmaticbot_websockets.includes(entry.ws)) {
                    console.log('[PragmaticBot] 소급 캡처:', entry.url);
                    setupGameWebSocket(entry.ws, entry.url);
                }
            });
        }
        // WS_RELEASE 수신 시 캡처 해제
        if (event.data.type === 'PRAGMATICBOT_WS_RELEASE') {
            console.log('[PragmaticBot] WebSocket 캡처 해제됨');
            window.__pragmaticbot_websockets = [];
            window.__pragmaticbot_ws = null;
        }
    });

    // 도메인 매칭 함수
    function matchesGameDomain(url) {
        // PragmaticBot 서버 자체 연결은 제외 (무한루프 방지)
        if (url.includes('localhost') || url.includes('127.0.0.1')) {
            console.log('[PragmaticBot] localhost 제외:', url);
            return false;
        }
        // 도메인 필터 없으면 모든 WebSocket 캡처
        if (gameDomains.length === 0) {
            console.log('[PragmaticBot] 도메인 필터 없음 - 전체 캡처');
            return true;
        }
        // PP는 로드밸런싱으로 저장된 subdomain(dga/gs15/gs18/gs20 등)과
        // 실제 베팅 채널 subdomain이 다를 수 있다 (2026-04-23 진단 확정:
        // DB에 dga.pragmaticplaylive.net이 저장됐으나 실제 베팅은 gs15에서 발생
        // → 기존 /^gs\d+\./ 와일드카드는 dga에는 적용 안 되어 매칭 실패).
        // base domain(마지막 2 레벨)까지 fallback해 같은 provider 내 어떤 subdomain이든 매칭.
        var matched = gameDomains.some(function (domain) {
            if (url.includes(domain)) return true;
            var parts = domain.split('.');
            if (parts.length >= 2) {
                var baseDomain = parts.slice(-2).join('.');
                if (url.includes(baseDomain)) return true;
            }
            return false;
        });
        console.log('[PragmaticBot] 도메인 체크:', url, '도메인:', gameDomains, '결과:', matched);
        return matched;
    }

    // 게임 WebSocket 설정 함수 - 모든 메시지를 캡처하여 전달
    function setupGameWebSocket(ws, url) {
        window.__pragmaticbot_websockets.push(ws);
        window.__pragmaticbot_ws = ws;

        ws.addEventListener('open', function () {
            console.log('[PragmaticBot] WebSocket OPEN:', url);
            window.__pragmaticbot_ws = ws;
        });

        ws.addEventListener('close', function () {
            console.log('[PragmaticBot] WebSocket CLOSED:', url);
            const idx = window.__pragmaticbot_websockets.indexOf(ws);
            if (idx > -1) {
                window.__pragmaticbot_websockets.splice(idx, 1);
            }
            const trackIdx = allCreatedWebSockets.findIndex(function (entry) { return entry.ws === ws; });
            if (trackIdx > -1) {
                allCreatedWebSockets.splice(trackIdx, 1);
            }
            if (window.__pragmaticbot_ws === ws) {
                window.__pragmaticbot_ws = window.__pragmaticbot_websockets.find(
                    s => s.readyState === WebSocket.OPEN
                ) || null;
            }
        });

        // ★ 모든 수신 메시지를 캡처하여 content.js로 전달 (Phase 1: 프로토콜 분석)
        var msgCount = 0;
        ws.addEventListener('message', function (event) {
            try {
                var data = event.data;
                msgCount++;

                // 디버그: 처음 5개 + 매 100번째 메시지 로그
                if (msgCount <= 5 || msgCount % 100 === 0) {
                    console.log('[PragmaticBot] WS msg #' + msgCount +
                        ' type=' + typeof data +
                        (typeof data === 'string' ? ' len=' + data.length : '') +
                        (data instanceof Blob ? ' blob=' + data.size : ''));
                }

                // ★ 문자열 데이터 처리
                if (data && typeof data === 'string') {
                    window.postMessage({
                        type: 'PRAGMATICBOT_WS_MESSAGE',
                        direction: 'receive',
                        url: url,
                        data: data
                    }, '*');
                }
                // ★ Blob 데이터 처리 (PP가 binary로 보낼 경우)
                else if (data instanceof Blob) {
                    var reader = new FileReader();
                    reader.onload = function () {
                        window.postMessage({
                            type: 'PRAGMATICBOT_WS_MESSAGE',
                            direction: 'receive',
                            url: url,
                            data: reader.result
                        }, '*');
                    };
                    reader.readAsText(data);
                }
                // ★ ArrayBuffer 처리
                else if (data instanceof ArrayBuffer) {
                    var text = new TextDecoder().decode(data);
                    window.postMessage({
                        type: 'PRAGMATICBOT_WS_MESSAGE',
                        direction: 'receive',
                        url: url,
                        data: text
                    }, '*');
                }
            } catch (e) {
                console.log('[PragmaticBot] 메시지 캡처 오류:', e);
            }
        });

        // ★ send 메서드 후킹 - 전송 메시지도 캡처 (binary 포함)
        const originalSend = ws.send.bind(ws);
        ws.send = function (data) {
            try {
                var sendData = null;
                if (typeof data === 'string') {
                    sendData = data;
                } else if (data instanceof ArrayBuffer) {
                    sendData = new TextDecoder().decode(data);
                }
                if (sendData) {
                    window.postMessage({
                        type: 'PRAGMATICBOT_WS_MESSAGE',
                        direction: 'send',
                        url: url,
                        data: sendData
                    }, '*');
                }
            } catch (e) {
                // 캡처 실패해도 전송은 계속
            }
            return originalSend(data);
        };

        // content.js에 캡처 알림
        window.postMessage({
            type: 'PRAGMATICBOT_WS_CAPTURED',
            url: url
        }, '*');
    }

    // WebSocket 생성자 오버라이드
    window.WebSocket = function (url, protocols) {
        console.log('[PragmaticBot] WebSocket 생성:', url);

        // 원본 WebSocket 생성
        const ws = protocols
            ? new OriginalWebSocket(url, protocols)
            : new OriginalWebSocket(url);

        // 모든 WebSocket을 추적 (도메인 설정 전에 생성된 것도 포함)
        allCreatedWebSockets.push({ ws: ws, url: url });

        // 도메인 매칭되는 WebSocket 캡처
        var isMatch = url && matchesGameDomain(url);
        console.log('[PragmaticBot] 도메인 매칭 결과:', {
            url: url,
            gameDomains: gameDomains,
            isMatch: isMatch
        });

        if (isMatch) {
            console.log('[PragmaticBot] 게임 WebSocket 캡처됨:', url);
            setupGameWebSocket(ws, url);
        } else {
            console.log('[PragmaticBot] 캡처 스킵:', url);
        }

        return ws;
    };

    // 프로토타입 복사
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

    // ★ prototype.send 전역 후킹 - inject.js 주입 이전에 이미 생성된 WebSocket도 잡기
    // (CDP document_start 주입이라도 multibaccarat iframe에서 페이지 스크립트가 먼저 new WebSocket을 호출하면
    //  생성자 override가 무효화됨. prototype.send는 모든 인스턴스가 공유하므로 소급 캡처가 가능하다.)
    const _origPrototypeSend = OriginalWebSocket.prototype.send;
    OriginalWebSocket.prototype.send = function (data) {
        try {
            var wsUrl = this.url || '';
            // 인스턴스 단위로 1회만 setupGameWebSocket 실행
            if (!this.__pragmaticbot_instance_hooked && wsUrl && matchesGameDomain(wsUrl)) {
                this.__pragmaticbot_instance_hooked = true;
                if (!window.__pragmaticbot_websockets.includes(this)) {
                    console.log('[PragmaticBot] prototype.send 소급 캡처:', wsUrl);
                    setupGameWebSocket(this, wsUrl);
                }
            }
        } catch (e) {
            // 후킹 실패해도 원본 전송은 계속
        }
        return _origPrototypeSend.apply(this, arguments);
    };

    // OPEN 상태인 WebSocket 찾기
    function findOpenWebSocket() {
        if (window.__pragmaticbot_ws && window.__pragmaticbot_ws.readyState === WebSocket.OPEN) {
            return window.__pragmaticbot_ws;
        }
        return window.__pragmaticbot_websockets.find(ws => ws.readyState === WebSocket.OPEN) || null;
    }

    // content.js로부터 메시지 수신 (Phase 2: 베팅 요청)
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;

        if (event.data.type === 'PRAGMATICBOT_SEND_BET') {
            const message = event.data.message;
            const ws = findOpenWebSocket();

            if (ws) {
                console.log('[PragmaticBot] 베팅 메시지 전송');
                ws.send(message);
                window.postMessage({
                    type: 'PRAGMATICBOT_SEND_RESULT',
                    success: true
                }, '*');
            } else {
                console.log('[PragmaticBot] WebSocket 연결 안됨');
                window.postMessage({
                    type: 'PRAGMATICBOT_SEND_RESULT',
                    success: false,
                    error: 'WebSocket not connected'
                }, '*');
            }
        }
    });

    console.log('[PragmaticBot] WebSocket 후킹 완료 - gameDomains:', gameDomains);

    // ★ fetch/XHR 후킹 - HTTP 응답에서 잔액 자동 감지
    let lastHttpBalance = null;
    var lastWalletBalanceUrl = '';  // wallet/balance URL 캡처 (FETCH_BALANCE에서 재사용)

    // 잔액 키워드 목록 (C# TryExtractBalance와 동일)
    var httpBalanceKeys = ['balance', 'credit', 'fund', 'amount', 'money', 'wallet', 'cash', 'coins', 'total_balance', 'totalbalance', 'player_balance', 'playerbalance'];

    /**
     * JSON 객체를 재귀 탐색하여 잔액 키워드에 매칭되는 숫자 값을 추출합니다.
     */
    function tryExtractBalanceFromJson(obj) {
        if (obj === null || obj === undefined) return null;
        if (typeof obj !== 'object') return null;

        if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) {
                var result = tryExtractBalanceFromJson(obj[i]);
                if (result !== null) return result;
            }
            return null;
        }

        var keys = Object.keys(obj);
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k].toLowerCase();
            var val = obj[keys[k]];

            // 잔액 키워드 매칭
            var matched = false;
            for (var b = 0; b < httpBalanceKeys.length; b++) {
                if (key.indexOf(httpBalanceKeys[b]) !== -1) {
                    matched = true;
                    break;
                }
            }

            if (matched) {
                // 숫자 값
                if (typeof val === 'number' && val > 0) return val;
                // 문자열 숫자
                if (typeof val === 'string') {
                    var cleaned = val.replace(/[^0-9.,]/g, '').replace(/,/g, '');
                    var num = parseFloat(cleaned);
                    if (!isNaN(num) && num > 0) return num;
                }
            }

            // 중첩 객체/배열 재귀
            if (typeof val === 'object' && val !== null) {
                var nested = tryExtractBalanceFromJson(val);
                if (nested !== null) return nested;
            }
        }
        return null;
    }

    /**
     * HTTP 응답 텍스트에서 잔액을 추출하여 postMessage로 전달합니다.
     */
    function tryExtractBalanceFromHttp(text, url) {
        if (!text || text.length < 2) return;

        // ★ wallet/balance URL만 허용 (tableConfig 1,000원, lobby/tables 60원 등 오감지 차단)
        if (!url || url.indexOf('wallet/balance') === -1) return;

        // JSON만 처리
        if (text[0] !== '{' && text[0] !== '[') return;

        // ★ wallet/balance URL 캡처 (FETCH_BALANCE 강제 호출용)
        lastWalletBalanceUrl = url;

        try {
            var json = JSON.parse(text);
            var balance = tryExtractBalanceFromJson(json);
            if (balance !== null && balance !== lastHttpBalance) {
                lastHttpBalance = balance;
                console.log('[PragmaticBot] HTTP 잔액 감지:', balance, 'URL:', url);
                window.postMessage({
                    type: 'PRAGMATICBOT_HTTP_BALANCE_UPDATE',
                    balance: balance,
                    url: url
                }, '*');
            }
        } catch (e) {
            // JSON 파싱 실패 무시
        }
    }

    /**
     * URL이 후킹 대상인지 확인 (localhost/PragmaticBot 자체 요청 제외)
     */
    function isHttpHookTarget(url) {
        if (!url) return true;
        var s = url.toString().toLowerCase();
        return s.indexOf('localhost') === -1 && s.indexOf('127.0.0.1') === -1;
    }

    // fetch 후킹
    var originalFetch = window.fetch;
    window.fetch = function() {
        var args = arguments;
        var url = (args[0] && typeof args[0] === 'string') ? args[0] :
                  (args[0] && args[0].url) ? args[0].url : '';

        return originalFetch.apply(this, args).then(function(response) {
            if (isHttpHookTarget(url)) {
                try {
                    var clone = response.clone();
                    clone.text().then(function(text) {
                        tryExtractBalanceFromHttp(text, url);
                    }).catch(function() {});
                } catch(e) {}
            }
            return response;
        });
    };

    // XMLHttpRequest 후킹
    var OriginalXHR = window.XMLHttpRequest;
    var xhrProto = OriginalXHR.prototype;
    var originalOpen = xhrProto.open;
    var originalSend = xhrProto.send;

    xhrProto.open = function() {
        this.__pragmaticbot_url = arguments[1] || '';
        return originalOpen.apply(this, arguments);
    };

    xhrProto.send = function() {
        var xhr = this;
        var url = xhr.__pragmaticbot_url || '';

        if (isHttpHookTarget(url)) {
            var onReady = xhr.onreadystatechange;
            xhr.onreadystatechange = function() {
                if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
                    try {
                        tryExtractBalanceFromHttp(xhr.responseText, url);
                    } catch(e) {}
                }
                if (onReady) return onReady.apply(this, arguments);
            };

            xhr.addEventListener('load', function() {
                try {
                    tryExtractBalanceFromHttp(xhr.responseText, url);
                } catch(e) {}
            });
        }

        return originalSend.apply(this, arguments);
    };

    console.log('[PragmaticBot] fetch/XHR 후킹 완료');

    // ★ FETCH_BALANCE 명령 수신 시 PP wallet API 강제 호출
    window.addEventListener('message', function(event) {
        if (event.data && event.data.type === 'PRAGMATICBOT_FETCH_BALANCE') {
            var url = lastWalletBalanceUrl || '/api/wallet/balance';
            console.log('[PragmaticBot] FETCH_BALANCE 요청:', url);
            fetch(url, { credentials: 'include' })
                .then(function(r) { return r.text(); })
                .then(function(text) {
                    // lastHttpBalance를 초기화하여 동일 값이라도 강제 전파
                    lastHttpBalance = null;
                    tryExtractBalanceFromHttp(text, url);
                })
                .catch(function(e) {
                    console.log('[PragmaticBot] FETCH_BALANCE 실패:', e);
                });
        }
    });

    // ★ DOM 잔액 스크래핑 (PP는 WebSocket으로 잔액을 보내지 않음)
    let lastBalance = null;

    // PP 잔액 요소 탐색 (복수 셀렉터 시도)
    function findBalanceElement() {
        // 1순위: PP Live 알려진 셀렉터들
        var selectors = [
            '.balance-value',
            '.balanceValue',
            '[data-qa="balance"]',
            '[data-testid="balance"]',
            '.user-balance',
            '.balance-amount',
            '.lobby-balance-value',
            '.balance .value',
            '.headerBalance',
            '.header-balance'
        ];
        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.textContent.trim()) return el;
        }

        // 2순위: balance 관련 속성/클래스를 가진 리프 요소
        var allElements = document.querySelectorAll('*');
        for (var j = 0; j < allElements.length; j++) {
            var elem = allElements[j];
            var cls = (elem.className || '').toString().toLowerCase();
            var id = (elem.id || '').toLowerCase();
            if ((cls.includes('balance') || id.includes('balance')) && elem.children.length === 0) {
                var text = elem.textContent.trim();
                if (text && /[\d,]+\.?\d*/.test(text)) return elem;
            }
        }
        return null;
    }

    // 잔액 텍스트에서 숫자 추출
    function parseBalance(text) {
        if (!text) return null;
        var cleaned = text.replace(/[^0-9.,]/g, '').replace(/,/g, '');
        var num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
    }

    // 2초마다 잔액 폴링
    setInterval(function () {
        var el = findBalanceElement();
        if (!el) return;

        var balance = parseBalance(el.textContent);
        if (balance !== null && balance !== lastBalance) {
            lastBalance = balance;
            window.postMessage({
                type: 'PRAGMATICBOT_BALANCE_UPDATE',
                balance: balance
            }, '*');
        }
    }, 2000);

    // ★ 3순위: 베팅 전후 DOM 차이 감지 (잔액 셀렉터 자동 발견)
    // 감지된 셀렉터 캐시 (세션당 1회만 전송)
    let detectedBalanceSelector = null;
    let domSnapshot = null;

    /**
     * 페이지 내 모든 숫자 표시 요소를 스냅샷합니다.
     * @returns {Array<{selector: string, value: number, text: string, element: Element}>}
     */
    function takeNumericSnapshot() {
        var results = [];
        // TreeWalker로 텍스트 노드 탐색
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            var text = walker.currentNode.textContent.trim();
            if (!text) continue;
            // 5자리 이상 숫자를 포함하는 텍스트만
            var cleaned = text.replace(/[^0-9]/g, '');
            if (cleaned.length < 5) continue;
            var numVal = parseInt(cleaned, 10);
            if (isNaN(numVal) || numVal <= 0 || numVal > 100000000) continue;

            var parent = walker.currentNode.parentElement;
            if (!parent) continue;
            // 버튼, 칩 등 베팅 UI 제외
            var pcls = (parent.className || '').toString().toLowerCase();
            if (pcls.includes('button-cart') || pcls.includes('chip') ||
                pcls.includes('stake') || pcls.includes('bet-amount') ||
                pcls.includes('ag_')) continue;
            if (parent.tagName === 'BUTTON') continue;

            // 고유 셀렉터 생성
            var selector = buildSelector(parent);
            results.push({
                selector: selector,
                value: numVal,
                text: text,
                element: parent
            });
        }
        return results;
    }

    /**
     * 요소에 대한 CSS 셀렉터를 생성합니다.
     */
    function buildSelector(el) {
        if (el.id) return '#' + el.id;
        var parts = [];
        var current = el;
        for (var depth = 0; current && current !== document.body && depth < 5; depth++) {
            var tag = current.tagName.toLowerCase();
            if (current.id) {
                parts.unshift('#' + current.id);
                break;
            }
            var cls = current.className ? current.className.toString().trim().split(/\s+/)[0] : '';
            if (cls) {
                parts.unshift(tag + '.' + cls);
            } else {
                // nth-child 사용
                var idx = 1;
                var sib = current.previousElementSibling;
                while (sib) { idx++; sib = sib.previousElementSibling; }
                parts.unshift(tag + ':nth-child(' + idx + ')');
            }
            current = current.parentElement;
        }
        return parts.join(' > ');
    }

    // 베팅 전 스냅샷 요청 수신
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;

        if (event.data.type === 'PRAGMATICBOT_SNAPSHOT_BEFORE_BET') {
            // 이미 감지된 셀렉터가 있으면 스냅샷 불필요
            if (detectedBalanceSelector) return;
            domSnapshot = takeNumericSnapshot();
            console.log('[PragmaticBot] DOM 스냅샷 저장: ' + domSnapshot.length + '개 요소');
        }

        if (event.data.type === 'PRAGMATICBOT_SNAPSHOT_AFTER_BET') {
            if (detectedBalanceSelector || !domSnapshot) return;
            var betAmount = event.data.betAmount || 0;
            if (betAmount <= 0) { domSnapshot = null; return; }

            // 베팅 후 스냅샷과 비교
            var afterSnapshot = takeNumericSnapshot();
            var tolerance = betAmount * 0.1; // 10% 오차 허용 (수수료 등)

            for (var i = 0; i < domSnapshot.length; i++) {
                var before = domSnapshot[i];
                // 같은 셀렉터의 after 값 찾기
                for (var j = 0; j < afterSnapshot.length; j++) {
                    var after = afterSnapshot[j];
                    if (before.selector === after.selector) {
                        var diff = before.value - after.value;
                        // 베팅 금액만큼 줄어든 요소 = 잔액 요소
                        if (diff > 0 && Math.abs(diff - betAmount) <= tolerance) {
                            detectedBalanceSelector = before.selector;
                            console.log('[PragmaticBot] DOM 차이로 잔액 셀렉터 감지: ' + detectedBalanceSelector +
                                ' (before=' + before.value + ', after=' + after.value + ', bet=' + betAmount + ')');
                            window.postMessage({
                                type: 'PRAGMATICBOT_BALANCE_SELECTOR_DETECTED',
                                selector: detectedBalanceSelector,
                                balance: after.value
                            }, '*');
                            domSnapshot = null;
                            return;
                        }
                        break;
                    }
                }
            }
            domSnapshot = null;
        }
    });

    // 게임 iframe 세션 유지 (30초마다 마우스 이벤트)
    setInterval(function () {
        if (window.__pragmaticbot_websockets && window.__pragmaticbot_websockets.length > 0) {
            document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true,
                cancelable: true,
                clientX: Math.floor(Math.random() * window.innerWidth),
                clientY: Math.floor(Math.random() * window.innerHeight)
            }));
        }
    }, 30000);

})();
