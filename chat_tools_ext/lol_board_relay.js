/* lol_board_relay.js — ISOLATED world content script
 *
 * MAIN world(lol_board_bridge.js)는 chrome.* API에 접근할 수 없으므로,
 * window CustomEvent로 요청을 받아 background로 넘기고 응답을 되돌려준다.
 *   MAIN --('cth-lolapi-req')--> [relay] --chrome.runtime--> background
 *   background --> [relay] --('cth-lolapi-res')--> MAIN
 * detail은 world 경계를 안전하게 넘기기 위해 JSON 문자열로 주고받는다.
 */
(() => {
  if (window.__cthLolRelayInstalled) return;
  window.__cthLolRelayInstalled = true;

  /* 자유게시판 신버전 대응 on/off (팝업 설정 체크박스) 를 MAIN world 브리지에 전달.
   * MAIN world는 chrome.storage에 접근 못 하므로 dataset 플래그로 넘긴다. 기본 ON. */
  function applyNewBoardFlag(v) {
    document.documentElement.dataset.cthNewBoard = (v === false) ? '0' : '1';
  }
  chrome.storage.local.get('cthNewBoardApi', (d) => applyNewBoardFlag(d.cthNewBoardApi));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.cthNewBoardApi) applyNewBoardFlag(ch.cthNewBoardApi.newValue);
  });

  window.addEventListener('cth-lolapi-req', (ev) => {
    let req;
    try { req = JSON.parse(ev.detail); } catch (e) { return; }
    if (!req || !req.reqId) return;

    const reply = (resp) => {
      window.dispatchEvent(new CustomEvent('cth-lolapi-res', {
        detail: JSON.stringify({ reqId: req.reqId, resp })
      }));
    };

    try {
      chrome.runtime.sendMessage(
        { type: 'cth-lolapi', kind: req.kind, params: req.params },
        (resp) => {
          if (chrome.runtime.lastError) {
            reply({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          reply(resp || { ok: false, error: 'no response' });
        }
      );
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  });
})();
