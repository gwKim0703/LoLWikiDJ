/* lol_board_bridge.js — MAIN world content script
 *
 * DJ 사이트가 자유게시판을 신 REST API에 직접 대응(서버 lolwiki-api.js)하면서,
 * 확장이 게시판 데이터를 대신 가져오던 '신버전 대응'은 더 이상 필요하지 않다.
 * 목록·글·댓글 조회와 글/댓글 작성(이미지 첨부 포함)·삭제·차단은 모두 사이트가 처리한다.
 *
 * 이 스크립트에 남은 역할은 사이트가 아직 제공하지 않는 것들의 보강이다.
 *  - 시각 표기: 렌더 직전에 목록 before / 댓글 reply_date 를 'N분 전 / HH:MM / 날짜'로 서식화
 *  - 답글 표시: 사이트가 parent_id 를 데이터로만 주므로, 부모 아래 정렬 + 들여쓰기
 *  - 상세 로딩 표시: 글 클릭 즉시 '불러오는 중…'(사이트 렌더가 끝나면 해제)
 *  - 추천/비추천: 사이트는 추천만 지원 → 신 API로 비추천·토글까지 처리
 *  - 알림센터(🔔): 사이트에 아직 없는 알림·쪽지 UI
 *  - 프로필 아이콘 갱신: 다른 앱에서 아이콘을 바꿔도 즉시 반영
 *
 * 인증은 사이트 로그인 창의 자격증명에 편승해 확장도 자체 토큰을 확보한다(별도 로그인 없음).
 * 신 API 호출은 CORS 우회를 위해 background(=relay 경유)에서 수행한다.
 */
(() => {
  if (window.__cthLolBoardBridge) return;
  window.__cthLolBoardBridge = true;

  const W = window;
  const log = (...a) => { try { console.log('[cth-board]', ...a); } catch (e) {} };

  /* ---------------- background fetch 브리지 (relay 경유) ---------------- */
  let _reqSeq = 0;
  const _pending = new Map();
  W.addEventListener('cth-lolapi-res', (ev) => {
    let out;
    try { out = JSON.parse(ev.detail); } catch (e) { return; }
    const cb = _pending.get(out.reqId);
    if (cb) { _pending.delete(out.reqId); cb(out.resp); }
  });
  function apiFetch(kind, params) {
    return new Promise((resolve) => {
      const reqId = 'r' + (++_reqSeq);
      _pending.set(reqId, resolve);
      W.dispatchEvent(new CustomEvent('cth-lolapi-req', {
        detail: JSON.stringify({ reqId, kind, params })
      }));
      setTimeout(() => {
        if (_pending.has(reqId)) { _pending.delete(reqId); resolve({ ok: false, error: 'timeout' }); }
      }, 15000);
    });
  }

  /* ---------------- helpers ---------------- */
  const s = (v) => (v == null ? '' : String(v));
  // img.lolwiki.kr 이미지 서버는 Referer 핫링크 보호가 걸려 있어, lolwiki.xyz Referer로 요청하면
  // 실제 이미지 대신 'BG.GG 접속시 확인 가능' 안내 이미지로 302 리다이렉트한다.
  // DJ 서버의 /lolwiki_mirror 프록시를 경유하면
  //  (1) 서버가 Referer 없이 원본을 받아와 정상 이미지를 반환하고 (모든 사용자에게 보임),
  //  (2) 이미지가 DJ 사이트와 동일 출처(same-origin)가 되어 채팅창으로 드래그 시 파일로 인식되므로
  //      기존 자유게시판처럼 이미지 끌어놓기 공유가 정상 동작한다.
  // (기존 자유게시판도 http 이미지를 lol_convert_uri_to_mirror로 미러 경유시켜 같은 방식으로 동작했다.)
  function mirrorUrl(url) {
    url = s(url);
    if (!url) return url;
    if (url.indexOf('/lolwiki_mirror/') !== -1) return url;                 // 이미 미러 경유
    if (/^https?:\/\/(img\.lolwiki\.kr|lolwiki\.kr)\//i.test(url)) {
      return W.location.origin + '/lolwiki_mirror/i?uri=' + encodeURIComponent(url);
    }
    return url;
  }
  function setImg(el, url) {
    if (!el || !url) return;
    const m = mirrorUrl(url);
    if (el.getAttribute('src') !== m) el.src = m;
  }
  /* 시각 문자열 파싱 → 절대시각(epoch) + KST 표시값.
     서버가 오프셋 없이(KST naive) 주기도 하고 'Z'/'+00:00' 을 붙여 주기도 한다.
     오프셋이 있으면 그대로 존중하고, 없을 때만 KST로 본다.
     (오프셋을 무시하면 9시간이 어긋나 방금 쓴 글이 어제 날짜로 보인다) */
  function parseTs(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|z|[+-]\d{2}:?\d{2})?/.exec(s(iso).trim());
    if (!m) return null;
    let tz = m[7] || '+09:00';
    if (tz === 'z') tz = 'Z';
    if (tz !== 'Z' && tz.indexOf(':') === -1) tz = tz.slice(0, 3) + ':' + tz.slice(3);   // +0900 → +09:00
    const epoch = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') + tz);
    if (!isFinite(epoch)) return null;
    const k = new Date(epoch + 9 * 3600 * 1000);       // 표시는 항상 KST 기준
    const p2 = (n) => (n < 10 ? '0' + n : String(n));
    const date = k.getUTCFullYear() + '-' + p2(k.getUTCMonth() + 1) + '-' + p2(k.getUTCDate());
    const hm = p2(k.getUTCHours()) + ':' + p2(k.getUTCMinutes());
    return { epoch: epoch, Y: k.getUTCFullYear(), Mo: k.getUTCMonth() + 1, D: k.getUTCDate(),
             date: date, hm: hm, full: date + ' ' + hm + ':' + p2(k.getUTCSeconds()) };
  }

  // 목록/댓글 시간 표기:
  //  · 3초 이내 → 'now'
  //  · 1분 미만 → 'N초전'
  //  · 1시간 미만 → 'N분전'
  //  · 12시간 미만 → 'N시간전'   (모두 날짜가 바뀌어도 경과시간 우선)
  //  · 12시간 이상 + 오늘(같은 날짜) → 'HH:MM' (24시간)
  //  · 그 외 → 'YYYY-MM-DD'
  // withTitle=true 면 마우스를 올렸을 때 정확한 시각이 보이도록 title 속성을 붙인다.
  function fmtRelTime(iso, withTitle) {
    // 타임스탬프 서식(작게 size=1). 경과 구간별로 색을 다르게 주며, DJ 사이트 테마(라이트/다크)에
    // 맞춰 색을 달리한다. 테마는 <html theme="default|dark"> 속성으로 판별(렌더 시점 기준).
    //   now(3초 이내)  라이트 #E53935 / 다크 #EF5350
    //   N초 전         라이트 #501C60 / 다크 #CE93D8
    //   N분 전·HH:MM   라이트 #8C3A38 / 다크 #964B53
    //   날짜           회색 #B2B2B2 (공통)
    // bold=true 면 <b>(font-weight:800로 한 단계 더 굵게)로 감싼다. 댓글 렌더의 </font>→</b></font>
    // 치환과 목록 CSS(font-weight:bold)와 함께 자연스럽게 굵게 보인다. 날짜는 bold 없이(회색·보통).
    const dark = document.documentElement.getAttribute('theme') === 'dark';
    const C_NOW = dark ? '#EF5350' : '#E53935';
    const C_SEC = dark ? '#CE93D8' : '#501C60';
    const C_MIN = dark ? '#964B53' : '#8C3A38';
    const C_DATE = '#B2B2B2';
    const p = parseTs(iso);
    const tip = (withTitle && p) ? ' title="' + nEsc(p.full) + '"' : '';
    const wrap = (t, color, bold) =>
      '<font color=' + color + ' size=1' + tip + '>' + (bold ? '<b style="font-weight:800">' + t + '</b>' : t) + '</font>';
    if (!p) return s(iso) ? wrap(s(iso).slice(0, 10), C_DATE, false) : '';
    const diffSec = Math.floor((Date.now() - p.epoch) / 1000);
    const diffMin = Math.floor(diffSec / 60);
    if (diffSec <= 3) return wrap('now', C_NOW, true);              // 방금(3초 이내)
    if (diffSec < 60) return wrap(diffSec + '초전', C_SEC, true);
    if (diffMin < 60) return wrap(diffMin + '분전', C_MIN, true);   // 날짜가 바뀌어도 1시간 미만이면 '분전'
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 12) return wrap(diffHour + '시간전', C_MIN, true);  // 12시간까지는 날짜 대신 경과시간
    // 12시간 이상: 지금(KST)과 같은 날이면 시:분, 아니면 날짜
    const nk = new Date(Date.now() + 9 * 3600 * 1000);
    if (nk.getUTCFullYear() === p.Y && (nk.getUTCMonth() + 1) === p.Mo && nk.getUTCDate() === p.D) {
      return wrap(p.hm, C_MIN, true);
    }
    return wrap(p.date, C_DATE, false);   // 회색·보통
  }
  /* 글/댓글의 author_id 가 내 식별자 중 하나와 일치하면 내 것.
     사이트 서버는 author_id 를 local_user_key 하고만 비교해서, 레거시 계정(author_id 가
     legacy_id/UUID 형식)은 내 글인데도 my_post=0 으로 내려온다 → 삭제 버튼이 사라진다.
     그래서 렌더 직전에 local_user_key·legacy_id·android/device id 를 모두 비교해 보정한다. */
  function isMyContent(authorId) {
    if (!authorId) return false;
    const ids = W.__cthMyIds || [];
    for (let i = 0; i < ids.length; i++) if (ids[i] === authorId) return true;
    return false;
  }

  // 본문의 '@닉네임' 멘션을 파란 하이라이트 스팬으로 감싸 플레인 텍스트와 시각적으로 구분한다.
  // 나머지 본문은 그대로 두고(<,> 는 건너뛰어 기존 HTML을 깨지 않음) 멘션 토큰만 감싼다.
  // (댓글은 index_lol.js에서 text.innerHTML = reply_title 로 렌더되므로 스팬이 그대로 적용됨)
  function decorateMentions(body) {
    if (!body) return body;
    return String(body).replace(/(^|[\s(])@([^\s@<>]{1,30})/g,
      function (m, pre, nick) { return pre + '<span class="cth-mention">@' + nick + '</span>'; });
  }

  /* ---------------- 시각 표기 후처리 + 답글 스레드 표시 ----------------
     DJ 사이트가 신 API로 목록/글을 직접 가져오므로, 확장은 '렌더 직전'에 사이트 데이터의
     시각 필드(목록 before / 댓글 reply_date, 형식 "YYYY-MM-DD HH:MM:SS")를 보기 좋은 서식으로
     바꾸고, 댓글은 parent_id 로 부모 아래에 정렬해 렌더 후 들여쓰기를 입힌다.
     (사이트는 parent_id 를 데이터로만 주고 계층 표시는 아직 하지 않는다) */
  const RAW_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;   // 사이트가 주는 원본 시각 형식

  // 답글을 부모 댓글 바로 아래로 정렬하고 깊이(__cthDepth)를 매긴다.
  function threadReplies(arr) {
    const bySeq = {}, children = {}, roots = [];
    arr.forEach((r) => { bySeq[s(r.reply_seq)] = r; });
    arr.forEach((r) => {
      const pid = r.parent_id;
      if (pid && s(pid) !== '0' && bySeq[s(pid)]) (children[s(pid)] = children[s(pid)] || []).push(r);
      else roots.push(r);
    });
    const out = [];
    (function walk(list, depth) {
      for (const r of list) { r.__cthDepth = depth; out.push(r); if (children[s(r.reply_seq)]) walk(children[s(r.reply_seq)], depth + 1); }
    })(roots, 0);
    return out;
  }
  // 렌더 직전: 목록 항목의 시각 표기를 교체(사이트는 e['before'] 를 innerHTML 로 렌더).
  function prepList() {
    const list = W.g_lol_article_list;
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!e) continue;
      // 원본 시각을 따로 보관하고 렌더할 때마다 다시 계산한다.
      // (한 번만 바꾸면 페이지를 열어둔 채 시간이 흘러도 'N분전'이 그대로 멈춰 있게 된다)
      // 앞뒤 공백을 먼저 털어낸다 — 공백이 섞이면 서식화를 건너뛰어 '공백+날짜'가 그대로 보였다.
      if (e.__cthRaw == null) { const raw = s(e.before).trim(); if (RAW_TS.test(raw)) e.__cthRaw = raw; }
      if (e.__cthRaw) e.before = fmtRelTime(e.__cthRaw, true);
    }
  }
  /* 렌더 직후: 목록에서 시간(=[spec])의 글자 시작점을 제목([title])과 맞춘다.
     두 요소의 박스 위치·여백은 같은데도 글자는 한 칸 밀려 보인다(글꼴/글자 크기에 따른
     좌측 여백 차이). 그래서 실제로 그려진 첫 글자의 좌표를 재서 차이만큼 보정한다. */
  function firstGlyphLeft(el) {
    try {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) { if (n.nodeValue && n.nodeValue.trim()) break; }
      if (!n) return NaN;
      const i = n.nodeValue.search(/\S/);                 // 첫 '보이는' 글자
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + 1);
      const rect = r.getBoundingClientRect();
      return (rect.width || rect.height) ? rect.left : NaN;
    } catch (e) { return NaN; }
  }
  function alignListSpec() {
    const board = document.getElementById('lol_lpanel_board');
    if (!board) return;
    for (const item of board.querySelectorAll('.lol_article_list_item')) {
      const sp = item.querySelector('[spec]');
      if (!sp || sp.__cthAligned) continue;
      sp.__cthAligned = 1;
      // (1) 맨 앞 텍스트의 선행 공백 제거(태그 안쪽에 있어도 잡히도록 첫 텍스트 노드를 찾는다)
      try {
        const w = document.createTreeWalker(sp, NodeFilter.SHOW_TEXT);
        const t = w.nextNode();
        if (t && /^\s/.test(t.nodeValue)) t.nodeValue = t.nodeValue.replace(/^\s+/, '');
      } catch (e) {}
      // (2) 실제 글자 시작 좌표를 재서 제목과 어긋난 만큼 좌측 여백으로 보정
      const ti = item.querySelector('[title]');
      if (!ti) continue;
      const tl = firstGlyphLeft(ti), sl = firstGlyphLeft(sp);
      if (!isFinite(tl) || !isFinite(sl)) continue;
      const diff = sl - tl;
      if (Math.abs(diff) < 0.5) continue;                  // 이미 맞으면 건드리지 않음
      const cur = parseFloat(getComputedStyle(sp).marginLeft) || 0;
      sp.style.marginLeft = (cur - diff) + 'px';
    }
  }

  // 렌더 직전: 댓글 시각·멘션 표기 교체 + 답글을 부모 아래로 정렬.
  let _prepSeq = '';
  function prepDetail() {
    const d = W.g_lol_current_detail;
    if (!d) return;
    if (s(d.post_seq) !== _prepSeq) {      // 다른 글로 이동하면 답글 대상 초기화
      _prepSeq = s(d.post_seq);
      if (cthReply.parent_id) { cthReply.parent_id = null; cthReply.nick = ''; }
    }
    // 내 글 판정 보정 → 사이트의 '삭제' 버튼이 다시 표시된다(사이트는 '1' 문자열로 비교)
    if (d.my_post !== '1' && isMyContent(s(d.author_id))) d.my_post = '1';
    if (!Array.isArray(d.replys)) return;
    for (const r of d.replys) {
      if (!r) continue;
      if (r.my_post != 1 && isMyContent(s(r.author_id))) r.my_post = 1;   // 내 댓글 삭제 버튼
      // 시각: 원본을 보관하고 렌더마다 다시 계산(마우스를 올리면 정확한 시각 표시)
      // 목록과 마찬가지로 앞뒤 공백을 털어낸 뒤 판별한다.
      if (r.__cthRaw == null) { const raw = s(r.reply_date).trim(); if (RAW_TS.test(raw)) r.__cthRaw = raw; }
      if (r.__cthRaw) r.reply_date = fmtRelTime(r.__cthRaw, true);
      // 멘션 강조는 시간과 무관하므로 한 번만
      if (!r.__cthMent) { if (r.reply_title) r.reply_title = decorateMentions(s(r.reply_title)); r.__cthMent = 1; }
    }
    d.replys = threadReplies(d.replys);
  }
  /* ---------------- 답글 작성 UI ----------------
     사이트는 댓글 작성 시 parent_id 를 0 으로 고정해 보내므로(=답글로 등록되지 않음),
     '답글' 대상이 지정된 경우에만 확장이 작성을 가로채 parent_id 와 함께 보낸다.
     일반 댓글은 그대로 사이트가 처리한다(둘 다 이미지 첨부 정상). */
  const cthReply = { parent_id: null, nick: '' };   // 현재 답글 대상
  function setReplyTarget(seq, nick) {
    cthReply.parent_id = seq; cthReply.nick = nick || '';
    positionReplyWrite();          // 입력창을 대상 댓글 바로 아래로 이동 + 답글 바 표시
    // 입력창엔 '@닉네임'을 넣지 않는다(깔끔하게 유지). 등록 시점에 본문 앞에 자동 삽입.
    const inp = document.getElementById('lol_rpanel_reply_board_input'); if (inp) inp.focus();
  }
  function clearReplyTarget() {
    cthReply.parent_id = null; cthReply.nick = '';
    positionReplyWrite();           // 입력창을 원위치(맨 아래)로 복귀 + 답글 바 제거
  }
  // 입력창(write container)을 사이트가 named-global로 참조하므로, 리스트 안에 넣어둔 채로
  // 사이트 렌더(리스트 removeChild)가 돌면 요소가 분리되어 깨진다. 따라서 렌더 전에는 항상
  // 맨 아래(원위치)에 두고, 렌더 후에만 대상 아래로 옮긴다.
  function restoreWriteToBottom() {
    const cont = document.getElementById('lol_rpanel_reply_board_write_container');
    const board = document.getElementById('lol_rpanel_reply_board');
    if (cont && board && cont.parentElement !== board) board.appendChild(cont);
  }
  function positionReplyWrite() {
    const cont = document.getElementById('lol_rpanel_reply_board_write_container');
    if (!cont) return;
    if (cthReply.parent_id) {
      const rlist = document.getElementById('lol_rpanel_reply_board_list');
      const key = String(cthReply.parent_id).replace(/["\\]/g, '\\$&');
      const item = rlist && rlist.querySelector('.lol_reply_list_item[seq="' + key + '"]');
      if (item) item.after(cont);        // 대상 댓글 바로 아래로 이동
      else restoreWriteToBottom();
      showReplyBar();
    } else {
      restoreWriteToBottom();
      const bar = document.getElementById('cth-board-reply-bar'); if (bar) bar.remove();
    }
  }
  function showReplyBar() {
    const cont = document.getElementById('lol_rpanel_reply_board_write_container');
    if (!cont || !cont.parentElement) return;
    // ID/클래스는 content.js 채팅 답장 UI('cth-reply-bar')와 충돌하지 않게 'cth-board-' 접두
    let bar = document.getElementById('cth-board-reply-bar');
    if (!bar) bar = document.createElement('div');
    bar.id = 'cth-board-reply-bar';
    cont.parentElement.insertBefore(bar, cont);
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;font-size:12px;color:#ccc;background:rgba(51,154,240,.13);border-radius:6px;margin:0 5px 4px';
    bar.innerHTML = '<span>↳ <b>' + nEsc(cthReply.nick) + '</b> 님에게 답글</span>' +
      '<span id="cth-board-reply-cancel" style="cursor:pointer;color:#e03131;font-weight:bold">✕ 취소</span>';
    const cancel = document.getElementById('cth-board-reply-cancel'); if (cancel) cancel.onclick = clearReplyTarget;
  }

  // 렌더 직후: 답글 깊이만큼 들여쓰기 + 각 댓글에 '답글' 버튼 주입.
  function decorateAllReplies() {
    const rlist = document.getElementById('lol_rpanel_reply_board_list');
    if (!rlist) return;
    const bySeq = {};
    const d = W.g_lol_current_detail;
    if (d && Array.isArray(d.replys)) for (const r of d.replys) if (r) bySeq[s(r.reply_seq)] = r;
    for (const item of rlist.querySelectorAll('.lol_reply_list_item')) {
      const seq = item.getAttribute('seq');
      const r = bySeq[seq];
      if (r) {
        const depth = Math.min(r.__cthDepth || 0, 4);
        item.style.marginLeft = (depth * 22) + 'px';
        if (depth > 0) { item.style.borderLeft = '2px solid var(--롤백_보더색)'; item.style.paddingLeft = '8px'; item.style.boxSizing = 'border-box'; }
      }
      const nc = item.querySelector('[nick_container]');
      // 클래스명은 content.js의 채팅 답장 버튼 '.cth-reply-btn'(display:none)과 충돌하지 않게 별도 사용
      if (seq && nc && !nc.querySelector('.cth-board-reply-btn')) {
        const nickEl = item.querySelector('[nick]');
        const nick = nickEl ? nickEl.textContent : '';
        const btn = document.createElement('div');
        btn.className = 'cth-board-reply-btn no-drag';
        btn.textContent = '답글';
        btn.style.cssText = 'cursor:pointer;color:#339af0;font-size:11px;font-weight:bold;margin-left:10px;white-space:nowrap;flex-shrink:0';
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setReplyTarget(seq, nick); });
        nc.appendChild(btn);
      }
    }
    // 렌더로 리스트가 새로 그려졌으니, 답글 대상이 있으면 입력창을 그 아래로 다시 이동
    positionReplyWrite();
  }

  /* ---------------- 댓글 애니메이션 이미지(GIF/WebP) 첨부 ----------------
     사이트의 댓글 이미지 경로는 붙여넣은 이미지를 캔버스로 JPEG 변환(첫 프레임만)해 보내고
     형식 정보도 보내지 않아, GIF/움직이는 WebP 를 붙여넣어도 정지 이미지가 된다.
     (글쓰기 경로에는 원본 GIF 를 보관하는 처리가 있지만 WebP 는 거기서도 변환된다)
     → 붙여넣는 순간 원본 바이트를 따로 보관해 두었다가, 등록할 때 확장이 원본 형식으로 올린다. */
  const CTH_KEEP_FMT = { 'image/gif': 'gif', 'image/webp': 'webp' };   // 캔버스 변환 시 손상되는 형식
  const cthOrig = { data: '', fmt: '' };
  function installReplyGifCapture() {
    const ph = document.getElementById('lol_rpanel_reply_board_write_image_placeholder');
    if (ph && !ph.__cthGifHooked) {
      ph.__cthGifHooked = true;
      // 캡처 단계로 먼저 읽기만 하고 막지는 않는다(사이트의 미리보기 처리는 그대로 동작).
      ph.addEventListener('paste', (e) => {
        cthOrig.data = ''; cthOrig.fmt = '';
        try {
          const cd = e.clipboardData || W.clipboardData;
          const f = cd && cd.files && cd.files[0];
          const fmt = f && CTH_KEEP_FMT[f.type];
          if (fmt) {
            const fr = new FileReader();
            fr.onload = () => { cthOrig.data = String(fr.result).split(',')[1] || ''; cthOrig.fmt = fmt; };
            fr.readAsDataURL(f);
          }
        } catch (err) {}
      }, true);
    }
    // 첨부를 지우면 보관해둔 원본도 함께 버린다
    if (typeof W.lol_clear_reply_image === 'function' && !W.lol_clear_reply_image.__cthWrapped) {
      const orig = W.lol_clear_reply_image;
      W.lol_clear_reply_image = function () { cthOrig.data = ''; cthOrig.fmt = ''; return orig.apply(this, arguments); };
      W.lol_clear_reply_image.__cthWrapped = true;
    }
  }

  /* ---------------- 글쓰기 사진 첨부 (최대 10장 · 순서 변경) ----------------
     사이트의 첨부란은 사진을 한 장만 받고, GIF 외에는 캔버스로 JPEG 변환해 보낸다
     (움직이는 WebP 는 정지 이미지가 되고, 여러 장은 아예 넣을 수 없다).
     앱은 10장까지 올릴 수 있으므로 첨부란을 확장이 대신 그려 같은 수를 지원한다.
       · 점선 칸에 붙여넣기(Ctrl+V)/드롭 → 첨부, 이후 [+] 로 같은 칸을 다시 열어 추가
       · 타일을 끌어다 놓으면 글에 보이는 순서가 바뀐다 (a,b,c,d → a,d,b,c)
       · GIF/WebP 는 원본 바이트 그대로 올리고(애니메이션 유지), 그 외는 사이트처럼 JPEG 로 변환
     등록은 확장이 신 API 로 처리한다. 확장 인증이 없을 때를 대비해 첫 장은 사이트 전역변수에도
     넣어 두어, 사이트 기본 경로로 넘어가도 최소한 한 장은 첨부된 채로 등록된다. */
  const CTH_WIMG_MAX = 10;
  const CTH_WIMG_MAX_BYTES = 30 * 1024 * 1024;   // LegacyPostImage.byte_size 상한
  const cthWriteImgs = [];         // [{ data(base64), fmt, preview(dataURL) }] — 배열 순서 = 글에 보일 순서
  let cthWriteSlotOpen = false;    // 빈 첨부칸(점선)이 열려 있는가
  let cthWriteBusy = 0;            // 읽기/변환 중인 파일 수
  let cthWriteDrag = -1;           // 순서 변경 중인 타일 index

  function ensureWriteImgStyle() {
    if (document.getElementById('cth-wimg-style')) return;
    const st = document.createElement('style'); st.id = 'cth-wimg-style';
    st.textContent = `
      /* 사이트 [image-holder] 는 flex 라 첨부란이 가로로 늘어난다. 확장 UI 는 세로로 쌓는다. */
      #lol_write [image-holder]{flex-direction:column;align-items:flex-start}
      #cth-wimgs{display:flex;flex-wrap:wrap;gap:10px;width:100%}
      .cth-wimg{position:relative;width:150px;height:150px;flex:0 0 auto;border-radius:6px;
        box-sizing:border-box;display:flex;align-items:center;justify-content:center}
      .cth-wimg img{max-width:100%;max-height:100%;object-fit:contain;cursor:grab;border:2px solid red;
        border-radius:4px;background:rgba(128,128,128,.12)}
      .cth-wimg[dragging]{opacity:.4}
      .cth-wimg[drag_over]::after{content:'';position:absolute;inset:-4px;border:2px dashed #339af0;
        border-radius:8px;pointer-events:none}
      /* 순서 배지 — 끌어 놓은 순서가 글에 그대로 보인다는 걸 숫자로 알려준다 */
      .cth-wimg-order{position:absolute;left:4px;top:4px;min-width:18px;height:18px;padding:0 5px;
        border-radius:9px;background:rgba(0,0,0,.66);color:#fff;font-size:11px;font-weight:bold;
        line-height:18px;text-align:center;pointer-events:none}
      .cth-wimg-del{position:absolute;right:3px;top:3px;width:20px;height:20px;border-radius:50%;
        background:rgba(0,0,0,.66);color:#fff;font-size:12px;font-weight:bold;line-height:20px;
        text-align:center;cursor:pointer;user-select:none}
      .cth-wimg-del:hover{background:#e03131}
      /* 붙여넣기/드롭 칸 — 사이트의 점선 사각형과 같은 모양을 유지한다 */
      .cth-wimg-drop{width:100%;max-width:400px;height:200px;padding:0;text-align:center;
        border:1px dashed red;background:transparent;caret-color:transparent;font-size:large;cursor:pointer}
      .cth-wimg-drop::placeholder{color:red;font-weight:bold}
      .cth-wimg-add{border:1px dashed red;color:red;font-size:40px;font-weight:bold;cursor:pointer;
        user-select:none;line-height:1}
      .cth-wimg-add:hover{background:rgba(224,49,49,.08)}
      /* 안내문 + [전체 비우기] 한 줄. 사진이 없으면 줄째로 감춘다. */
      #cth-wimg-bar{display:none;align-items:center;gap:10px;margin-top:8px;width:100%}
      #cth-wimg-guide{color:red;font-weight:bold}
      #cth-wimg-clear{flex-shrink:0;margin-left:auto;font-family:inherit;font-size:11px;
        border:1px solid #999;border-radius:5px;padding:3px 9px;background:transparent;color:#888;cursor:pointer}
      #cth-wimg-clear:hover{border-color:#e03131;background:rgba(224,49,49,.10);color:#e03131}
    `;
    document.head.appendChild(st);
  }

  function b64ByteLength(b64) {
    const n = b64 ? b64.length : 0;
    if (!n) return 0;
    return Math.floor(n * 3 / 4) - (b64[n - 1] === '=' ? 1 : 0) - (b64[n - 2] === '=' ? 1 : 0);
  }

  // 파일 → {data, fmt, preview}. GIF/WebP 는 원본 유지, 그 외는 사이트와 같이 JPEG 로 변환한다.
  function cthReadWriteImage(file) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onerror = () => resolve(null);
      fr.onload = () => {
        const url = String(fr.result || '');
        const keep = CTH_KEEP_FMT[file.type];
        if (keep) { resolve({ data: url.split(',')[1] || '', fmt: keep, preview: url }); return; }
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          const cv = document.createElement('canvas');
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          cv.getContext('2d').drawImage(img, 0, 0);
          const jpeg = cv.toDataURL('image/jpeg');
          resolve({ data: jpeg.split(',')[1] || '', fmt: 'jpg', preview: jpeg });
        };
        img.src = url;
      };
      fr.readAsDataURL(file);
    });
  }

  // 사이트 기본 경로(확장 인증 없음)로 넘어가도 한 장은 남도록 첫 장을 사이트 전역변수에 반영.
  // 사이트가 보낼 수 있는 형식은 JPEG 와 GIF 뿐이라, WebP 는 넘기기 직전에 JPEG 로 바꿔 채운다.
  function syncWriteImgsToSite() {
    const first = cthWriteImgs[0];
    try {
      W.g_lol_write_image_data = first && first.fmt === 'jpg' ? first.data : '';
      W.g_lol_write_image_data_gif = first && first.fmt === 'gif' ? first.data : '';
    } catch (e) {}
  }
  function toJpegBase64(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onerror = () => resolve('');
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        resolve(cv.toDataURL('image/jpeg').split(',')[1] || '');
      };
      img.src = dataUrl;
    });
  }

  async function addWriteImages(files) {
    const list = Array.from(files || []).filter((f) => f && /^image\//.test(f.type));
    if (!list.length) { alert('이미지가 아닙니다.'); return; }
    const room = CTH_WIMG_MAX - cthWriteImgs.length;
    if (room <= 0) { alert('사진은 최대 ' + CTH_WIMG_MAX + '장까지 첨부할 수 있습니다.'); return; }
    const take = list.slice(0, room);
    if (list.length > room) alert('사진은 최대 ' + CTH_WIMG_MAX + '장까지 첨부할 수 있습니다.');

    cthWriteBusy += take.length;
    cthWriteSlotOpen = false;
    renderWriteImgs();
    for (const f of take) {
      const got = await cthReadWriteImage(f);
      cthWriteBusy--;
      // 읽는 동안 다른 붙여넣기가 겹쳐 들어올 수 있으므로 담기 직전에 한 번 더 확인한다
      if (got && got.data && cthWriteImgs.length < CTH_WIMG_MAX) {
        if (b64ByteLength(got.data) > CTH_WIMG_MAX_BYTES)
          alert('사진 한 장이 30MB 를 넘어 첨부할 수 없습니다.' + (f.name ? '\n(' + f.name + ')' : ''));
        else
          cthWriteImgs.push(got);
      }
      renderWriteImgs();
    }
    syncWriteImgsToSite();
  }

  function clearWriteImages() {
    cthWriteImgs.length = 0;
    cthWriteSlotOpen = false;
    cthWriteDrag = -1;
    syncWriteImgsToSite();
    renderWriteImgs();
  }

  // [전체 비우기] — 한 장씩 ✕ 를 누르지 않아도 되게. 실수로 여러 장을 날리지 않도록 2장부터는 확인한다.
  function onClickClearAllImages() {
    if (cthWriteImgs.length > 1 && !W.confirm('첨부한 사진 ' + cthWriteImgs.length + '장을 모두 뺄까요?')) return;
    clearWriteImages();
  }

  function makeWriteTile(image, index) {
    const tile = document.createElement('div');
    tile.className = 'cth-wimg';
    tile.setAttribute('index', String(index));
    tile.draggable = true;
    tile.addEventListener('dragstart', (e) => {
      cthWriteDrag = index;
      tile.toggleAttribute('dragging', true);
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index)); } catch (err) {}
    });
    tile.addEventListener('dragend', () => { cthWriteDrag = -1; renderWriteImgs(); });
    tile.addEventListener('dragover', (e) => {
      if (cthWriteDrag < 0) return;                 // 파일 드롭은 점선 칸에서만 받는다
      e.preventDefault(); e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      tile.toggleAttribute('drag_over', true);
    });
    tile.addEventListener('dragleave', () => tile.toggleAttribute('drag_over', false));
    tile.addEventListener('drop', (e) => {
      if (cthWriteDrag < 0) return;
      e.preventDefault(); e.stopPropagation();
      const from = cthWriteDrag, to = index;
      cthWriteDrag = -1;
      if (from === to) { renderWriteImgs(); return; }
      cthWriteImgs.splice(to, 0, cthWriteImgs.splice(from, 1)[0]);
      syncWriteImgsToSite();                         // 순서가 바뀌면 첫 장도 바뀔 수 있다
      renderWriteImgs();
    });

    const img = document.createElement('img');
    img.src = image.preview;
    img.title = '끌어다 놓으면 사진 순서가 바뀝니다.';
    tile.appendChild(img);

    const order = document.createElement('div');
    order.className = 'cth-wimg-order';
    order.textContent = String(index + 1);
    tile.appendChild(order);

    const del = document.createElement('div');
    del.className = 'cth-wimg-del';
    del.textContent = '✕';
    del.title = '이 사진 빼기';
    del.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      cthWriteImgs.splice(index, 1);
      syncWriteImgsToSite();
      renderWriteImgs();
    });
    tile.appendChild(del);
    return tile;
  }

  function makeWriteDropSlot() {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'cth-wimg-drop';
    inp.placeholder = '여기에 붙여넣기(Ctrl+V) 또는 파일 드롭';
    inp.maxLength = 0;
    inp.addEventListener('input', () => { inp.value = ''; });      // 글자는 남기지 않는다
    inp.addEventListener('paste', (e) => {
      const cd = e.clipboardData || W.clipboardData;
      const files = cd && cd.files;
      if (files && files.length) { e.preventDefault(); addWriteImages(files); }
    });
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    inp.addEventListener('dragenter', (e) => { stop(e); inp.style.borderWidth = '10px'; });
    inp.addEventListener('dragover', (e) => { stop(e); inp.style.borderWidth = '10px'; });
    inp.addEventListener('dragleave', (e) => { stop(e); inp.style.borderWidth = '1px'; });
    inp.addEventListener('drop', (e) => {
      stop(e); inp.style.borderWidth = '1px';
      addWriteImages(e.dataTransfer && e.dataTransfer.files);
    });
    return inp;
  }

  function makeWriteAddButton() {
    const add = document.createElement('div');
    add.className = 'cth-wimg cth-wimg-add';
    add.textContent = '+';
    add.title = '사진 더 첨부하기';
    add.addEventListener('click', () => { cthWriteSlotOpen = true; renderWriteImgs(true); });
    return add;
  }

  // 사이트의 단일 첨부 UI 감추기. 사이트의 '취소' 처리가 첨부란을 다시 표시하므로 렌더마다 확인한다.
  function hideSiteWriteImageUI() {
    ['lol_write_image_placeholder', 'lol_write_image', 'lol_write_image_guide'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') el.style.display = 'none';
    });
  }

  // 첨부란 전체를 상태에서 다시 그린다(타일 → 점선 칸 또는 [+] → 안내문)
  function renderWriteImgs(focusSlot) {
    const box = document.getElementById('cth-wimgs');
    if (!box) return;
    hideSiteWriteImageUI();
    while (box.firstChild) box.removeChild(box.firstChild);

    cthWriteImgs.forEach((image, i) => box.appendChild(makeWriteTile(image, i)));

    let slot = null;
    if (cthWriteImgs.length < CTH_WIMG_MAX) {
      if (cthWriteSlotOpen || !cthWriteImgs.length) box.appendChild(slot = makeWriteDropSlot());
      else box.appendChild(makeWriteAddButton());
    }
    if (focusSlot && slot) slot.focus();

    const guide = document.getElementById('cth-wimg-guide');
    if (guide) {
      guide.textContent = cthWriteBusy ? '이미지 첨부 중... 기다려주셈'
        : cthWriteImgs.length ? '사진 ' + cthWriteImgs.length + '/' + CTH_WIMG_MAX + '장 첨부됨 · 사진을 끌어다 놓으면 순서가 바뀝니다.'
        : '';
    }
    const clear = document.getElementById('cth-wimg-clear');
    if (clear) clear.style.display = cthWriteImgs.length ? 'block' : 'none';
    const bar = document.getElementById('cth-wimg-bar');
    if (bar) bar.style.display = (cthWriteBusy || cthWriteImgs.length) ? 'flex' : 'none';
  }

  // 사이트의 단일 첨부 UI 를 감추고 확장 첨부란을 그 자리에 설치
  function installWriteImages() {
    // 글쓰기 취소로 폼이 비워지면 첨부도 함께 비운다
    if (typeof W.lol_onclick_write_cancel === 'function' && !W.lol_onclick_write_cancel.__cthWrapped) {
      const orig = W.lol_onclick_write_cancel;
      W.lol_onclick_write_cancel = function () {
        const subject = document.getElementById('lol_write_subject');
        const r = orig.apply(this, arguments);
        // 사이트는 확인 창에서 취소하면 값을 남겨두므로, 제목이 실제로 비워졌을 때만 첨부도 비운다
        if (subject && !subject.value) clearWriteImages();
        return r;
      };
      W.lol_onclick_write_cancel.__cthWrapped = true;
    }

    const holder = document.querySelector('#lol_write [image-holder]');
    if (!holder || holder.__cthWimgHooked) return;
    holder.__cthWimgHooked = true;
    ensureWriteImgStyle();

    const box = document.createElement('div');
    box.id = 'cth-wimgs';
    holder.insertBefore(box, holder.firstChild);

    const bar = document.createElement('div');
    bar.id = 'cth-wimg-bar';

    const guide = document.createElement('div');
    guide.id = 'cth-wimg-guide';
    bar.appendChild(guide);

    const clear = document.createElement('button');
    clear.id = 'cth-wimg-clear';
    clear.type = 'button';
    clear.className = 'no-drag';
    clear.textContent = '전체 비우기';
    clear.title = '첨부한 사진을 모두 뺍니다';
    clear.addEventListener('click', onClickClearAllImages);
    bar.appendChild(clear);

    holder.insertBefore(bar, box.nextSibling);

    renderWriteImgs();
    log('글쓰기 사진 첨부란 설치됨(최대 ' + CTH_WIMG_MAX + '장)');
  }

  // 글쓰기 등록(사진이 첨부된 경우 확장이 처리) — 사진이 없으면 사이트가 그대로 처리
  let _writingPost = false;
  async function handleWritePost(data) {
    data = data || {};
    if (!cthWriteImgs.length || _writingPost) return;
    if (cthWriteBusy) { alert('사진을 읽는 중입니다. 잠시 후 다시 등록해 주세요.'); return; }
    // 사이트 로그인 편승은 비동기라 페이지를 연 직후엔 아직 준비 중일 수 있다(댓글 작성과 동일하게 대기)
    if (!hasAuth()) {
      for (let i = 0; i < 25 && !hasAuth(); i++) await new Promise((r) => setTimeout(r, 200));
    }
    if (!hasAuth()) {                                  // 그래도 없으면 사이트 기본 동작으로(첫 장만 첨부)
      const first = cthWriteImgs[0];
      if (first && first.fmt === 'webp') {             // 사이트는 WebP 를 그대로 보내지 못한다
        const jpeg = await toJpegBase64(first.preview);
        try { W.g_lol_write_image_data = jpeg; W.g_lol_write_image_data_gif = ''; } catch (e) {}
        data = Object.assign({}, data, { image: jpeg, is_gif: false });
      }
      if (cthWriteImgs.length > 1)
        alert('확장 인증이 준비되지 않아 사진 1장만 첨부해 등록합니다.\n(글쓰기 등으로 한 번 로그인하면 다음부터 여러 장이 올라갑니다)');
      try { _origEmit('lol_write', data); } catch (e) {}   // 첨부 비우기는 사이트 등록 완료(lol_write) 때
      return;
    }
    _writingPost = true;
    const total = cthWriteImgs.length;
    const resp = await apiFetch('writePost', {
      request_id: genReqId(), title: s(data.subject), body: s(data.body),
      youtube_url: s(data.youtube_url),
      images: cthWriteImgs.map((it) => ({ image: it.data, image_format: it.fmt }))
    });
    _writingPost = false;
    if (resp && resp.ok) {
      clearWriteImages();
      // 사이트의 lol_write 응답 처리와 동일하게 정리
      try { W.lol_confirm_api_session(); } catch (e) {}
      ['lol_write_subject', 'lol_write_body', 'lol_write_youtube'].forEach((id) => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      try { W.lol_write_panel_toggle(false); } catch (e) {}
      try { W.lol_onclick_aritcle_list_refresh(); } catch (e) {}
      if (resp.image_ok === false) {
        const got = resp.image_count || 0;
        setTimeout(() => alert('글은 등록됐지만 사진 ' + total + '장 중 ' + got + '장만 첨부되었습니다.'
          + (resp.image_error ? '\n사유: ' + resp.image_error : '')), 50);
      }
    } else {
      const why = (resp && resp.data && (resp.data.detail || resp.data.message)) || (resp && (resp.status || resp.error)) || '오류';
      alert('글 등록 실패: ' + why);
    }
  }

  /* ---------------- 닉네임 우클릭 → 그 작성자의 글 목록 ----------------
     사이트의 '작성자 글 보기'는 서버가 mine=true 로 조회하는데, 이때 서버가 API 에
     mode=mine 을 함께 보내면서 author_id 필터가 무시된다(=결과가 비어 목록이 뜨지 않음).
       · author_id 만            → 정상
       · mode=mine + author_id  → 0건
     서버는 author_id 를 mine 일 때만 붙이므로 이 조합을 피할 수 없다.
     → 대신 사이트가 정상 지원하는 '닉네임 검색' 경로로 같은 결과를 얻는다
       (mode=latest + nickname → 그 작성자의 글만 조회됨). 조회는 그대로 사이트·서버가 수행. */
  function handleOthers(postSeq) {
    const d = W.g_lol_current_detail || {};
    const nick = s(d.nickname).trim();
    if (!nick) { try { _origEmit('lol_get_article_list_others', postSeq); } catch (e) {} return; }
    W.g_lol_search_body = '';
    W.g_lol_search_nick = nick;                      // 스크롤 추가 로딩에서도 필터 유지
    W.g_lol_search_vote = false;
    W.g_lol_search_mine = false;                     // mine 이면 서버가 mode=mine 을 붙여 결과가 비어버림
    W.g_lol_is_award = false;
    W.g_lol_article_scroll_seq = 0; W.g_lol_article_list = [];
    W.g_lol_lpanel_scroll_top_switch = true;
    W.g_lol_spec_android_id = W.g_lol_android_id;    // 작성자는 닉네임으로 거르므로 기본값(뷰어)
    try { W.lol_get_article_list(0, 30, '', nick, false, false); } catch (e) {}
  }

  // 댓글/답글 등록(사이트 emit 을 가로챈 경우) — 이미지(GIF 포함)도 함께 올린다.
  function genReqId() {
    return 'cth-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }
  let _writingReply = false;
  async function handleCommentSubmit(data) {
    data = data || {};
    const postSeq = data.post_seq || (W.g_lol_current_detail && W.g_lol_current_detail.post_seq);
    const parentId = cthReply.parent_id || 0;              // 0 이면 일반 댓글(= 원본 이미지 때문에 가로챈 경우)
    const orig = cthOrig.data;                              // 있으면 캔버스 JPEG 대신 원본(GIF/WebP)을 보낸다
    const image = orig || data.image || '';
    if (!postSeq || _writingReply) return;
    let body = s(data.body);
    if (!body && !image) return;
    const what = parentId ? '답글' : '댓글';
    // 사이트 로그인 편승은 비동기라, 처음에는 인증이 아직 준비 중일 수 있다.
    // 잠시 기다렸다가 그래도 없으면 사이트 기본 동작으로 넘긴다.
    if (!hasAuth()) {
      for (let i = 0; i < 25 && !hasAuth(); i++) await new Promise((r) => setTimeout(r, 200));
      if (!hasAuth()) {
        try { _origEmit('lol_write_reply', data); } catch (e) {}
        clearReplyTarget(); cthOrig.data = ''; cthOrig.fmt = '';
        setTimeout(() => alert('확장 인증이 준비되지 않아 사이트 기본 방식으로 등록했습니다.\n(답글·GIF는 다시 로그인한 뒤 이용해 주세요)'), 50);
        return;
      }
    }
    if (parentId && cthReply.nick) {                        // 답글이면 '@닉네임' 자동 삽입
      const tag = '@' + cthReply.nick + ' ';
      if (!body.startsWith(tag)) body = tag + body;
    }
    _writingReply = true;
    const resp = await apiFetch('writeComment', {
      post_seq: postSeq, parent_id: parentId, request_id: genReqId(),
      body: body, image: image, image_format: (orig ? cthOrig.fmt : '')
    });
    _writingReply = false;
    if (resp && resp.ok) {
      clearReplyTarget(); cthOrig.data = ''; cthOrig.fmt = '';
      const inp = document.getElementById('lol_rpanel_reply_board_input'); if (inp) inp.value = '';
      try { W.lol_clear_reply_image(); } catch (e) {}
      // 사이트가 댓글 목록을 다시 읽도록 상세를 재요청
      try { _origEmit('lol_get_article_detail', { post_seq: postSeq, android_id: W.g_lol_android_id }); } catch (e) {}
      if (image && resp.image_ok === false) {
        log(what + ' 이미지 업로드 실패:', resp.image_error, '| 데이터 길이:', s(image).length);
        setTimeout(() => alert(what + '은 등록됐지만 이미지는 첨부되지 않았습니다.\n사유: ' + (resp.image_error || '알 수 없음')), 50);
      }
    } else {
      const why = (resp && resp.data && (resp.data.detail || resp.data.message)) || (resp && (resp.status || resp.error)) || '오류';
      alert(what + ' 등록 실패: ' + why);
    }
  }

  /* ---------------- 5번째 이후 첨부 사진 ----------------
     사이트 상세는 사진 칸을 img1~img4 네 개만 두고 있어, 앱에서 10장까지 올릴 수 있게 된 지금은
     5번째부터가 아예 보이지 않는다(데이터는 image_urls 로 전부 내려온다).
     → 렌더가 끝난 뒤 img4 아래에 나머지를 같은 마크업으로 이어 붙인다.
     사이트와 동일한 class 를 쓰므로 확대/축소·'채팅창에 공유' 아이콘이 그대로 동작한다.
     (pic_multi/pic_new/doodlr 같은 구 데이터 경로는 4장을 넘지 않으므로 image_urls 만 본다) */
  const CTH_SITE_IMG_SLOTS = 4;
  let _extraImgSeq = '';
  function renderExtraImages() {
    const host = document.getElementById('lol_rpanel_body_img4');
    if (!host) return;
    const d = W.g_lol_current_detail || {};
    const urls = Array.isArray(d.image_urls) ? d.image_urls.filter(Boolean) : [];
    const extra = urls.slice(CTH_SITE_IMG_SLOTS);

    // 같은 글을 다시 그리는 경우엔 사진별 확대/축소 상태를 유지한다(사이트 img1~4 와 같은 동작)
    const old = Array.prototype.slice.call(document.querySelectorAll('.cth-extra-img'));
    const keep = s(d.post_seq) === _extraImgSeq ? old.map((e) => e.hasAttribute('small')) : [];
    _extraImgSeq = s(d.post_seq);
    old.forEach((e) => e.remove());
    if (!extra.length) return;

    const toMirror = typeof W.lol_convert_uri_to_mirror === 'function' ? W.lol_convert_uri_to_mirror : mirrorUrl;
    let after = host;
    extra.forEach((url, i) => {
      const div = document.createElement('div');
      div.className = 'lol_rpanel_img_body cth-extra-img';
      div.toggleAttribute('small', i < keep.length ? keep[i] : true);

      const img = document.createElement('img');
      img.className = 'lol_rpanel_img_img';
      img.style.width = '100%';
      img.src = toMirror(url);
      div.appendChild(img);

      const add = document.createElement('div');
      add.className = 'lol_rpanel_img_add';
      add.setAttribute('src', url);
      div.appendChild(add);

      div.onclick = W.lol_onclick_img;                 // 클릭 시 확대/축소 (사이트 함수 그대로)
      add.onclick = W.lol_onclick_img_add;             // 채팅창에 이미지 공유
      after.parentNode.insertBefore(div, after.nextSibling);
      after = div;
    });
  }

  /* ---------------- 게시글 추천/비추천 ---------------- */
  // 앱 규칙: 추천 0인 글은 비추천 불가(음수 방지), 1 이상이면 추천/비추천 모두 가능,
  //          내가 한 추천/비추천은 같은 버튼을 다시 눌러 취소(서버가 토글). 앱과 동일 엔드포인트라 동작 일치.
  function ensureVoteStyle() {
    if (document.getElementById('cth-vote-style')) return;
    const st = document.createElement('style'); st.id = 'cth-vote-style';
    st.textContent = `
      /* 추천 그래픽(like_frame.png, 100x67, flex 컬럼에서 align-self:center)의 바로 아래에
         가운데 정렬된 '비추천' 버튼을 둔다. align-self:center 로 가로로 늘어나지 않게 한다. */
      /* position:relative+z-index 필수: 추천 수(#..._like_count)가 position:relative,top:40px 로
         버튼 위를 투명하게 덮는데, positioned 요소라 그냥 두면 count 가 위에 그려져 클릭을 가로채
         (추천 버튼으로 버블링돼) 비추천이 오히려 추천이 된다. 버튼을 위로 올려 클릭이 닿게 한다. */
      #cth-dislike{position:relative;z-index:5;align-self:center;display:inline-flex;align-items:center;
        justify-content:center;gap:5px;margin:8px auto 2px;padding:5px 16px;border-radius:15px;
        font-size:12px;font-weight:bold;line-height:1.4;white-space:nowrap;cursor:pointer;user-select:none;
        border:1.5px solid;transition:opacity .12s,background .12s}
      #cth-dislike:hover{opacity:.82}
      #lol_rpanel_body_like.cth-voted{outline:3px solid #1c7ed6;outline-offset:2px;border-radius:10px}
      #cth-dislike.cth-voted{color:#fff !important;background:#e03131 !important;border-color:#e03131 !important}
      /* pointer-events:none 을 주면 안 된다 — 클릭이 버튼을 '통과'해 아래의 추천 버튼에 전달되어
         비추천이 오히려 추천 +1 이 된다. 버튼이 클릭을 흡수하고 핸들러에서 무시해야 한다. */
      #cth-dislike.cth-disabled{opacity:.35;cursor:default}
      :root[theme="dark"] #cth-dislike{color:#ee8a8a;border-color:#8a4141;background:rgba(224,49,49,.10)}
      :root[theme="default"] #cth-dislike{color:#c0392b;border-color:#e2a6a6;background:rgba(224,49,49,.06)}
    `;
    document.head.appendChild(st);
  }
  function renderVoteUI() {
    const d = W.g_lol_current_detail; if (!d) return;
    if (!hasAuth()) return;              // 확장 인증이 없으면 추천은 사이트 기본 동작에 맡긴다
    const likeBox = document.getElementById('lol_rpanel_body_like');
    const existingDown = document.getElementById('cth-dislike');
    if (!likeBox || likeBox.style.display === 'none') {          // 추천 UI 숨김(글쓰기 등)이면 비추천도 숨김
      if (existingDown) existingDown.style.display = 'none';
      return;
    }
    ensureVoteStyle();
    const likes = Number(d.likes) || 0;
    const vote = d.__cthVote || 'neutral';
    const cnt = document.getElementById('lol_rpanel_body_like_count');
    if (cnt) { if (cnt.firstChild) cnt.firstChild.nodeValue = likes; else cnt.textContent = String(likes); }
    likeBox.classList.toggle('cth-voted', vote === 'up');       // 내가 추천한 상태 강조
    // 비추천 버튼 주입(추천 버튼 바로 옆)
    let down = document.getElementById('cth-dislike');
    if (!down) {
      down = document.createElement('div');
      down.id = 'cth-dislike'; down.className = 'no-drag'; down.title = '비추천 (추천 수를 내림 · 다시 누르면 취소)';
      down.textContent = '▼ 비추천';
      down.addEventListener('click', function (e) {
        e.stopPropagation();
        const cur = W.g_lol_current_detail;
        if (cur) handleVote(cur.post_seq, 'down');
      });
      likeBox.parentNode.insertBefore(down, likeBox.nextSibling);
    }
    down.style.display = '';                                     // 숨김 상태였다면 다시 표시
    down.classList.toggle('cth-voted', vote === 'down');
    // 추천 0 & 내 비추천 아님 → 비추천 불가(앱과 동일). 클릭은 핸들러에서 무시한다.
    down.classList.toggle('cth-disabled', likes <= 0 && vote !== 'down');
  }
  // 사이트 데이터에는 '내 추천 상태'가 없으므로, 글이 열릴 때 신 API 상세로 vote 상태만 받아온다.
  let _voteStateSeq = '';
  async function loadVoteState() {
    const d = W.g_lol_current_detail;
    if (!d || !hasAuth()) return;
    const seq = s(d.post_seq);
    if (!seq || seq === _voteStateSeq) return;      // 같은 글이면 재조회하지 않음
    _voteStateSeq = seq;
    const dr = await apiFetch('detail', { post_seq: seq, local_user_key: myKey() });
    const cur = W.g_lol_current_detail;
    if (dr && dr.ok && dr.data && dr.data.post && cur && s(cur.post_seq) === seq) {
      cur.__cthVote = s(dr.data.post.vote) || 'neutral';
      if (dr.data.post.likes != null) cur.likes = dr.data.post.likes;
      renderVoteUI();
    }
  }
  let _voting = false;
  async function handleVote(postSeq, action) {
    if (_voting) return;
    if (!hasAuth()) return;                                                        // 확장 인증 없으면 처리 안 함
    if (!W.g_lol_android_id || W.g_lol_android_id === W.g_lol_guest_id) return;   // 게스트 불가
    const d = W.g_lol_current_detail;
    if (!d || s(d.post_seq) !== s(postSeq)) return;
    const likes = Number(d.likes) || 0;
    if (action === 'down' && likes <= 0 && d.__cthVote !== 'down') return;         // 클라 규칙(음수 방지)
    _voting = true;
    try {
      await apiFetch('vote', { post_seq: postSeq, action });
      // 서버가 토글/취소/전환을 결정 → 상세를 다시 읽어 실제 likes/vote 를 반영(추정 없이 진실만 표시).
      const dr = await apiFetch('detail', { post_seq: postSeq, local_user_key: myKey() });
      const cur = W.g_lol_current_detail;
      if (dr && dr.ok && dr.data && dr.data.post && cur && s(cur.post_seq) === s(postSeq)) {
        cur.likes = dr.data.post.likes || 0;
        cur.__cthVote = s(dr.data.post.vote) || 'neutral';
        renderVoteUI();
      }
    } catch (e) { log('vote 실패', e); }
    finally { _voting = false; }
  }

  /* ---------------- socket.emit 보강(가로채지 않고 곁들이는 처리) ---------------- */
  let _origEmit = null;

  // 상세 로딩 표시(클릭 즉시 반응). 사이트 DOM을 건드리지 않도록 body에 고정 위치 오버레이로 띄운다.
  // 응답이 오지 않는 경우에도 표시가 남지 않도록 안전 타이머로 자동 해제한다.
  let _loadingTimer = 0;
  function showDetailLoading(on) {
    let el = document.getElementById('cth-detail-loading');
    if (_loadingTimer) { clearTimeout(_loadingTimer); _loadingTimer = 0; }
    if (!on) { if (el) el.remove(); return; }
    _loadingTimer = setTimeout(() => { const e2 = document.getElementById('cth-detail-loading'); if (e2) e2.remove(); }, 15000);
    const panel = document.getElementById('lol_rpanel');
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    if (r.width === 0) return;                 // 패널이 숨김/미표시면 띄우지 않음
    if (!el) { el = document.createElement('div'); el.id = 'cth-detail-loading'; el.textContent = '불러오는 중…'; document.body.appendChild(el); }
    const dark = document.documentElement.getAttribute('theme') === 'dark';
    el.style.cssText = 'position:fixed;z-index:2147482000;left:' + (r.left + r.width / 2) + 'px;top:' + (r.top + 44) +
      'px;transform:translateX(-50%);padding:7px 14px;border-radius:14px;font-size:12px;font-weight:bold;pointer-events:none;' +
      (dark ? 'background:rgba(40,40,40,.92);color:#eee;box-shadow:0 2px 10px rgba(0,0,0,.5)'
            : 'background:rgba(255,255,255,.95);color:#333;box-shadow:0 2px 10px rgba(0,0,0,.18)');
  }

  /* ---------------- 인증: DJ 사이트 로그인에 편승 ----------------
     사이트가 자체 ID/PW 로그인으로 신 API를 쓰지만 토큰은 DJ 서버에만 있고 브라우저로 오지 않는다.
     확장에 남은 기능(알림센터·추천/비추천·프로필 아이콘 갱신)도 신 API Bearer 인증이 필요하므로,
     사이트 로그인 창에 입력된 자격증명을 그대로 재사용해 확장도 자체 토큰을 확보한다.
     → 사용자는 사이트에 한 번만 로그인하면 되고, 확장 전용 로그인 창은 없다.
     (이미 '세션 기억' 상태라 비밀번호가 비어 오면 다음 로그인 때 확보된다) */
  const GUEST_ID = 'LoLWikiDJ_Guest';
  function isGuest() {
    const id = W.g_lol_android_id;
    return !id || id === GUEST_ID || (typeof W.g_lol_guest_id !== 'undefined' && id === W.g_lol_guest_id);
  }
  function hasAuth() { return !!W.__cthLocalUserKey; }

  function cthLogout() {
    apiFetch('logout', {});
    W.__cthLocalUserKey = ''; W.__cthUserId = null; W.__cthMyIds = [];
    _voteStateSeq = '';
    try { refreshNotifBadge(); } catch (e) {}
    log('확장 인증 해제');
  }

  // 로그인 시 저장된 프로필은 로그인 시점 값이라, 다른 앱에서 아이콘을 바꿔도 갱신되지 않는다.
  // 목록 새로고침 때 GET /users/me 로 최신 아바타(및 닉네임/스택)를 받아와 좌측 상단 프로필을 즉시 교체한다.
  async function refreshMyProfile() {
    if (isGuest() || !W.g_lol_user_info || !hasAuth()) return;
    let resp;
    try { resp = await apiFetch('profile', {}); } catch (e) { return; }
    const u = resp && resp.ok && resp.data && (resp.data.user || resp.data.data || resp.data);
    if (!u || typeof u !== 'object') return;
    mergeMyIds(u);                                               // 내 글 판정용 식별자 최신화
    const info = W.g_lol_user_info; if (!info) return;
    const newAvatar = u.avatar_url || u.avatar || u.icon_url || '';
    if (newAvatar) info.__cthAvatar = newAvatar;                 // 이후 렌더에서도 최신값 사용
    const newNick = u.nickname || u.name; if (newNick) info.nickname = newNick;
    const st = (u.stack_count != null) ? u.stack_count : (u.point != null ? u.point : null);
    if (st != null) info.point = st;
    // 좌측 상단 아이콘 즉시 교체(변경된 이미지로)
    if (newAvatar) setImg(document.getElementById('lol_lpanel_account_icon'), newAvatar);
  }

  // 내 글/댓글 판정용 식별자 모음. author_id 는 계정 종류에 따라 local_user_key 이거나
  // legacy_id(UUID/hex) 라서, 알고 있는 식별자를 모두 모아 비교한다.
  function mergeMyIds(user) {
    const add = [user && user.local_user_key, user && user.legacy_id,
                 user && user.legacy_android_id, user && user.legacy_device_id];
    const set = new Set(W.__cthMyIds || []);
    for (const v of add) if (v) set.add(String(v));
    W.__cthMyIds = Array.from(set);
  }

  // 확장 자체 인증 상태만 기록한다(로그인 UI·사이트 상태는 모두 사이트가 관리).
  function applyAuth(user) {
    user = user || {};
    W.__cthLocalUserKey = user.local_user_key || user.localUserKey || '';   // 알림/쪽지용
    W.__cthUserId = user.id || user.user_id || null;                        // 알림센터 채팅 좌/우 구분용
    W.__cthMyIds = [];
    mergeMyIds(user);
    log('확장 인증 준비됨:', user.nickname || user.name || '');
    try { refreshNotifBadge(); } catch (e) {}
    try { refreshMyProfile(); } catch (e) {}
  }

  // 사이트 로그인 창에 입력된 자격증명으로 확장도 신 API에 로그인해 자체 토큰을 확보
  async function extLogin(accountId, password) {
    if (!accountId || !password || hasAuth()) return;
    const resp = await apiFetch('login', { account_id: accountId, password: password });
    if (resp && resp.ok) {
      const user = (resp.auth && resp.auth.user)
        || (resp.data && (resp.data.user || (resp.data.data && resp.data.data.user))) || null;
      applyAuth(user);
    } else {
      log('확장 인증 실패(사이트 로그인은 정상):', resp && (resp.status || resp.error));
    }
  }

  function installAuth() {
    // 사이트 로그인 흐름(lol_request_api_credentials)의 콜백을 감싸, 같은 자격증명으로 확장도 로그인
    if (!W.__cthCredHooked && typeof W.lol_request_api_credentials === 'function') {
      W.__cthCredHooked = true;
      const orig = W.lol_request_api_credentials;
      W.lol_request_api_credentials = function (callback) {
        return orig.call(this, function (credentials) {
          try {
            if (credentials && credentials.account_id && credentials.password) {
              extLogin(credentials.account_id, credentials.password);
            }
          } catch (e) {}
          return callback(credentials);
        });
      };
      log('사이트 로그인 편승 후킹 설치됨');
    }
    // 사이트 로그아웃 시 확장 인증도 함께 해제
    if (!W.__cthConfirmHooked) {
      W.__cthConfirmHooked = true;
      const origConfirm = (typeof W.confirm === 'function') ? W.confirm.bind(W) : null;
      W.confirm = function (message) {
        const r = origConfirm ? origConfirm(message) : true;
        if (r && typeof message === 'string' && message.indexOf('로그아웃') !== -1) setTimeout(cthLogout, 0);
        return r;
      };
    }
    // 페이지 로드 시 저장된 확장 인증(토큰) 복원
    if (!W.__cthAuthRestored) {
      W.__cthAuthRestored = true;
      apiFetch('authState', {}).then((resp) => {
        if (resp && resp.ok && resp.auth && resp.auth.user) applyAuth(resp.auth.user);
      });
    }
  }


  /* ---------------- 설치: 렌더 함수 래핑 + socket.emit 인터셉트 ----------------
     게시판 데이터는 이제 DJ 사이트가 신 API로 직접 가져오므로 가로채지 않는다.
     확장은 렌더 '직전'에 사이트 데이터의 표기만 다듬고, 렌더 '직후'에 DOM을 보강한다. */
  function wrapRenderFns() {
    if (typeof W.lol_lpanel_update === 'function' && !W.lol_lpanel_update.__cthWrapped) {
      const orig = W.lol_lpanel_update;
      W.lol_lpanel_update = function () {
        try { prepList(); } catch (e) {}                 // 목록 시각 표기 서식화
        const r = orig.apply(this, arguments);
        try { alignListSpec(); } catch (e) {}            // 시간 표기 시작점을 제목과 맞춤
        // 사이트 렌더가 계정 아이콘을 되돌릴 수 있어, 갱신해둔 최신 아바타를 다시 적용
        try {
          const av = W.g_lol_user_info && W.g_lol_user_info.__cthAvatar;
          if (av) setImg(document.getElementById('lol_lpanel_account_icon'), av);
        } catch (e) {}
        return r;
      };
      W.lol_lpanel_update.__cthWrapped = true;
    }
    if (typeof W.lol_rpanel_update === 'function' && !W.lol_rpanel_update.__cthWrapped) {
      const orig = W.lol_rpanel_update;
      W.lol_rpanel_update = function () {
        try { prepDetail(); } catch (e) {}               // 댓글 시각·멘션 서식화 + 답글 정렬
        // 렌더가 댓글 리스트를 removeChild로 비우므로, 입력창이 리스트 안에 있으면 분리되어 깨진다.
        // 렌더 전에는 항상 원위치로 빼두고, 렌더 후 decorateAllReplies에서 대상 아래로 재이동.
        try { restoreWriteToBottom(); } catch (e) {}
        const r = orig.apply(this, arguments);
        try { showDetailLoading(false); } catch (e) {}   // 글 내용이 떴으니 로딩 표시 해제
        try { renderExtraImages(); } catch (e) {}        // 사이트 칸(4개)을 넘는 첨부 사진
        try { decorateAllReplies(); } catch (e) {}       // 답글 들여쓰기 + '답글' 버튼
        try { renderVoteUI(); } catch (e) {}             // 추천/비추천 버튼·상태
        try { loadVoteState(); } catch (e) {}            // 내 추천 상태 조회(글이 바뀐 경우만)
        try { ensureBlockButtonBound(); } catch (e) {}   // '[차단하기]' 버튼에 신 API 차단 연결
        try {                                            // 내 글에는 '[차단하기]'(자기 차단) 숨김
          const bb = document.getElementById('lol_rpanel_header_button');
          const dd = W.g_lol_current_detail;
          if (bb && dd && !isGuest()) bb.style.display = (dd.my_post === '1') ? 'none' : '';
        } catch (e) {}
        return r;
      };
      W.lol_rpanel_update.__cthWrapped = true;
    }
  }

  function wrapSocket() {
    const sock = W.socket;
    if (!sock || typeof sock.emit !== 'function' || sock.emit.__cthWrapped) return !!(sock && sock.emit && sock.emit.__cthWrapped);
    _origEmit = sock.emit.bind(sock);
    const wrapped = function (event, ...args) {
      // 글을 클릭한 즉시 '불러오는 중…' 표시(요청은 사이트가 그대로 처리 → 렌더 시 해제)
      if (event === 'lol_get_article_detail') { try { showDetailLoading(true); } catch (e) {} }
      // 목록 새로고침(첫 페이지) 때 최신 프로필을 받아 좌측 상단 아이콘을 갱신
      if (event === 'lol_get_article_list' && args[0] && !(args[0].seq > 0)) {
        try { refreshMyProfile(); } catch (e) {}
      }
      // 추천은 확장이 가로채 신 API로 처리(추천/비추천 토글 지원). 확장 인증이 없으면 사이트 기본 동작.
      if (event === 'lol_like' && hasAuth()) { handleVote(args[0] && args[0].post_seq, 'up'); return sock; }
      // 닉네임 우클릭(작성자 글 목록) — 서버 경로가 동결된 구 PHP라 확장이 대신 처리
      if (event === 'lol_get_article_list_others') { handleOthers(args[0]); return sock; }
      // 글쓰기: 확장 첨부란에 사진이 있을 때만 가로챈다(사이트는 한 장만, 그마저도 JPEG 로 변환)
      if (event === 'lol_write' && cthWriteImgs.length) { handleWritePost(args[0]); return sock; }
      // 답글이거나 GIF 가 첨부된 경우에만 가로챈다(그 외 일반 댓글은 사이트가 그대로 처리).
      //  · 답글: 사이트는 parent_id 를 0 으로 고정해 보냄
      //  · GIF: 사이트는 캔버스로 JPEG 변환해 보내 애니메이션이 사라짐
      if (event === 'lol_write_reply' && (cthReply.parent_id || cthOrig.data)) {
        handleCommentSubmit(args[0]); return sock;
      }
      return _origEmit(event, ...args);
    };
    wrapped.__cthWrapped = true;
    sock.emit = wrapped;

    // 글 삭제 후 화면 갱신: 사이트 핸들러는 alert('삭제 되었습니다.') 만 하고 아무것도 갱신하지 않아
    // 확인을 눌러도 삭제된 글이 그대로 남아 보인다. 리스너를 하나 더 붙여(사이트 것 다음에 실행)
    // 상세를 비우고 목록을 새로고침한다.
    if (typeof sock.on === 'function') {
      // 사이트 기본 경로로 등록된 경우(확장 인증 없음) 첨부란도 함께 비운다.
      // 사이트 핸들러는 제목·내용·영상만 비우고 사진은 남겨 둔다.
      sock.on('lol_write', function () { try { clearWriteImages(); } catch (e) {} });
      sock.on('lol_delete', function () {
        try { W.g_lol_current_detail = {}; } catch (e) {}
        try { W.lol_rpanel_update(); } catch (e) {}                  // 상세 → '글이 존재하지 않습니다.'
        try { W.lol_onclick_aritcle_list_refresh(); } catch (e) {}   // 목록에서 제거
        const back = document.getElementById('cth-board-back-detail'); // 컴팩트 모드: 목록 뷰로 복귀
        if (back) back.click();
      });
    }
    log('socket.emit 보강 설치됨(로딩 표시·프로필 갱신·추천 처리·삭제 후 갱신)');
    return true;
  }

  /* ---------------- 알림센터 (신버전: 알림 탭 + 채팅=쪽지 탭) ---------------- */
  const cthN = { open: false, tab: 'notif', thread: null };
  function nEsc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function nRel(iso) {
    const p = parseTs(iso); if (!p) return '';
    const sec = Math.floor((Date.now() - p.epoch) / 1000), min = Math.floor(sec / 60);
    if (sec < 60) return Math.max(0, sec) + '초전';
    if (min < 60) return min + '분전';
    const hour = Math.floor(min / 60);
    if (hour < 12) return hour + '시간전';               // 목록/댓글 표기와 동일 규칙
    const nk = new Date(Date.now() + 9 * 3600 * 1000);
    if (nk.getUTCFullYear() === p.Y && nk.getUTCMonth() + 1 === p.Mo && nk.getUTCDate() === p.D) return p.hm;
    return p.date;
  }
  function nHM(iso) { const m = /[T ](\d{2}):(\d{2})/.exec(String(iso || '')); return m ? (m[1] + ':' + m[2]) : ''; }
  function nDay(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? (m[1] + '년 ' + (+m[2]) + '월 ' + (+m[3]) + '일') : ''; }
  function myKey() { return W.__cthLocalUserKey || ''; }
  function myNick() { return (W.g_lol_user_info && W.g_lol_user_info.nickname) || ''; }
  function noRefImg(url) { return url ? nEsc(url) : ''; }

  function injectNotifStyle() {
    if (document.getElementById('cth-notif-style')) return;
    const st = document.createElement('style'); st.id = 'cth-notif-style';
    st.textContent = `
      #cth-notif-icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;cursor:pointer;position:relative;font-size:19px;line-height:1;user-select:none;flex-shrink:0;margin-right:15px}
      #cth-notif-icon:hover{opacity:.8}
      #cth-notif-badge{position:absolute;top:0;right:0;min-width:15px;height:15px;background:#e03131;color:#fff;border-radius:8px;font-size:10px;line-height:15px;text-align:center;padding:0 3px;font-weight:bold;display:none;box-sizing:border-box}
      #cth-notif-badge.show{display:block}
      #cth-notif-panel{position:fixed;z-index:2147483000;width:340px;max-height:72vh;background:#1f1f1f;color:#ddd;border:1px solid #444;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:none;flex-direction:column;overflow:hidden;font-size:13px}
      #cth-notif-panel.show{display:flex}
      .cth-ntabs{display:flex;border-bottom:1px solid #333;flex-shrink:0}
      .cth-ntab{flex:1;text-align:center;padding:11px;cursor:pointer;color:#999}
      .cth-ntab.active{color:#fff;border-bottom:2px solid #339af0;font-weight:bold}
      .cth-nbody{overflow-y:auto;flex:1;min-height:120px}
      .cth-nitem{padding:10px 12px;border-bottom:1px solid #2a2a2a;cursor:pointer}
      .cth-nitem:hover{background:#2a2a2a}
      .cth-nitem.unread{background:#16324a}
      .cth-nitem .cth-ntitle{font-weight:bold;font-size:12px;color:#fff}
      .cth-nitem .cth-ntext{color:#bcbcbc;font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cth-nitem .cth-ntime{color:#777;font-size:11px;margin-top:3px}
      .cth-mthread{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #2a2a2a;cursor:pointer}
      .cth-mthread:hover{background:#2a2a2a}
      .cth-mthread img{width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0;background:#333}
      .cth-mmain{flex:1;min-width:0}
      .cth-mnick{font-weight:bold;color:#fff;font-size:12px}
      .cth-mlast{color:#aaa;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
      .cth-mmeta{text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:3px}
      .cth-mtime{color:#777;font-size:10px}
      .cth-munread{background:#e03131;color:#fff;border-radius:9px;font-size:10px;padding:1px 6px;font-weight:bold}
      .cth-nempty,.cth-nloading{padding:34px 12px;text-align:center;color:#777}
      /* 대화창 */
      .cth-conv-head{display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid #333;flex-shrink:0}
      .cth-conv-back{cursor:pointer;color:#ccc;font-size:16px;padding:2px 6px}
      .cth-conv-back:hover{color:#fff}
      .cth-conv-nick{font-weight:bold;color:#fff}
      .cth-conv-body{overflow-y:auto;flex:1;padding:10px;display:flex;flex-direction:column;gap:5px;min-height:120px}
      .cth-datesep{text-align:center;margin:8px 0 4px}
      .cth-datesep span{background:#2c2c2c;color:#9a9a9a;font-size:10px;padding:3px 12px;border-radius:11px}
      .cth-msgrow{display:flex;align-items:flex-start;gap:6px;max-width:100%;width:auto;margin:0;background:none}
      .cth-msgrow.cth-mine{justify-content:flex-end}
      .cth-msgrow.cth-them{justify-content:flex-start}
      .cth-msgav{width:30px;height:30px;border-radius:50%;object-fit:cover;flex-shrink:0;background:#2a2a2a}
      .cth-msgav-sp{width:30px;flex-shrink:0}
      .cth-msg{position:relative;max-width:74%;padding:7px 10px;border-radius:12px;font-size:12px;line-height:1.4;word-break:break-word;white-space:pre-wrap;width:auto;margin:0;text-align:left}
      .cth-msg.cth-mine{background:#1971c2;color:#fff;border-top-right-radius:4px}
      .cth-msg.cth-them{background:#3a3a3a;color:#eee;border-top-left-radius:4px}
      /* 상대 아바타 옆 첫 말풍선에 아바타 쪽을 향하는 꼬리 */
      .cth-msg.cth-them.cth-tail::before{content:'';position:absolute;left:-5px;top:9px;width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-right:6px solid #3a3a3a}
      .cth-msg img{max-width:100%;border-radius:6px;display:block;margin-top:4px}
      .cth-msg .cth-msgtime{font-size:9px;opacity:.55;margin-top:3px;text-align:right}
      .cth-conv-input{display:flex;gap:6px;padding:8px;border-top:1px solid #333;flex-shrink:0}
      .cth-conv-input input{flex:1;background:#2a2a2a;border:1px solid #444;border-radius:6px;color:#eee;padding:8px 10px;font-size:12px;outline:none}
      .cth-conv-input input:focus{border-color:#339af0}
      .cth-conv-input button{background:#1c7ed6;color:#fff;border:none;border-radius:6px;padding:0 14px;cursor:pointer;font-size:12px}
      .cth-conv-input button:disabled{opacity:.5;cursor:default}
      /* #1 대화 모드: 콘텐츠 영역을 세로 플렉스로 만들어 상단 헤더(뒤로가기+닉네임)와
         입력창은 고정하고 가운데 메시지 영역(.cth-conv-body)만 스크롤되게 한다. */
      #cth-notif-content.cth-conv-mode{display:flex;flex-direction:column;overflow:hidden;padding:0}
      /* ── #2 라이트 테마(DJ 사이트 :root[theme=default]) 연동 ── */
      :root[theme="default"] #cth-notif-panel{background:#fff;color:#222;border-color:#cfd6dd;box-shadow:0 8px 30px rgba(0,0,0,.18)}
      :root[theme="default"] .cth-ntabs{border-bottom-color:#e3e8ee}
      :root[theme="default"] .cth-ntab{color:#888}
      :root[theme="default"] .cth-ntab.active{color:#1971c2;border-bottom-color:#1971c2}
      :root[theme="default"] .cth-nitem{border-bottom-color:#eef1f4}
      :root[theme="default"] .cth-nitem:hover{background:#f2f5f8}
      :root[theme="default"] .cth-nitem.unread{background:#e7f1fb}
      :root[theme="default"] .cth-nitem .cth-ntitle{color:#222}
      :root[theme="default"] .cth-nitem .cth-ntext{color:#555}
      :root[theme="default"] .cth-nitem .cth-ntime{color:#999}
      :root[theme="default"] .cth-mthread{border-bottom-color:#eef1f4}
      :root[theme="default"] .cth-mthread:hover{background:#f2f5f8}
      :root[theme="default"] .cth-mthread img{background:#e5e5e5}
      :root[theme="default"] .cth-mnick{color:#222}
      :root[theme="default"] .cth-mlast{color:#666}
      :root[theme="default"] .cth-mtime{color:#999}
      :root[theme="default"] .cth-nempty,:root[theme="default"] .cth-nloading{color:#999}
      :root[theme="default"] .cth-conv-head{border-bottom-color:#e3e8ee}
      :root[theme="default"] .cth-conv-back{color:#666}
      :root[theme="default"] .cth-conv-back:hover{color:#111}
      :root[theme="default"] .cth-conv-nick{color:#222}
      :root[theme="default"] .cth-datesep span{background:#e9edf1;color:#667685}
      :root[theme="default"] .cth-msgav{background:#e5e5e5}
      :root[theme="default"] .cth-msg.cth-them{background:#eceff2;color:#222}
      :root[theme="default"] .cth-msg.cth-them.cth-tail::before{border-right-color:#eceff2}
      :root[theme="default"] .cth-conv-input{border-top-color:#e3e8ee}
      :root[theme="default"] .cth-conv-input input{background:#f0f3f6;border-color:#cfd6dd;color:#222}
    `;
    document.head.appendChild(st);
  }

  function closeNotifPanel() { const p = document.getElementById('cth-notif-panel'); if (p) p.classList.remove('show'); cthN.open = false; }
  function positionNotifPanel() {
    const ic = document.getElementById('cth-notif-icon'), p = document.getElementById('cth-notif-panel');
    if (!ic || !p) return;
    const r = ic.getBoundingClientRect();
    let left = Math.min(r.left, window.innerWidth - 350);
    p.style.left = Math.max(6, left) + 'px';
    p.style.top = (r.bottom + 6) + 'px';
  }

  function installNotificationCenter() {
    const header = document.getElementById('lol_lpanel_header');
    if (!header) return;
    // 쪽지함(구) 버튼 제거 — 알림센터로 대체
    const memoBtn = document.getElementById('lol_lpanel_userinfo_menu_button_memo');
    if (memoBtn) memoBtn.remove();

    if (document.getElementById('cth-notif-icon')) return; // 이미 설치됨
    injectNotifStyle();

    const icon = document.createElement('div');
    icon.id = 'cth-notif-icon';
    icon.title = '알림센터';
    icon.innerHTML = '🔔<span id="cth-notif-badge"></span>';
    // 우측 아이콘 그룹의 맨 왼쪽(유저정보 아이콘 앞)에 배치 → [🔔][유저정보][새로고침]
    const uinfo = document.getElementById('lol_lpanel_userinfo');
    if (uinfo && uinfo.parentElement === header) header.insertBefore(icon, uinfo);
    else header.appendChild(icon);

    const panel = document.createElement('div');
    panel.id = 'cth-notif-panel';
    panel.innerHTML =
      '<div class="cth-ntabs"><div class="cth-ntab" data-tab="notif">알림</div><div class="cth-ntab" data-tab="memo">채팅</div></div>' +
      '<div class="cth-nbody" id="cth-notif-content"></div>';
    document.body.appendChild(panel);

    icon.addEventListener('click', (e) => { e.stopPropagation(); cthN.open ? closeNotifPanel() : openNotifPanel(); });
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.querySelectorAll('.cth-ntab').forEach((t) => t.addEventListener('click', () => switchNotifTab(t.getAttribute('tab') || t.dataset.tab)));
    document.addEventListener('click', () => { if (cthN.open) closeNotifPanel(); });
    window.addEventListener('resize', () => { if (cthN.open) positionNotifPanel(); });

    // content.js가 나중에 쪽지함 버튼을 추가해도 신모드에선 제거 (알림센터로 대체)
    const menuC = document.getElementById('lol_lpanel_userinfo_menu_inner_background');
    if (menuC) new MutationObserver(() => {
      const b = document.getElementById('lol_lpanel_userinfo_menu_button_memo'); if (b) b.remove();
    }).observe(menuC, { childList: true });

    refreshNotifBadge();
    setInterval(refreshNotifBadge, 60000);
  }

  function openNotifPanel() {
    const p = document.getElementById('cth-notif-panel'); if (!p) return;
    cthN.open = true; cthN.thread = null;
    p.classList.add('show'); positionNotifPanel();
    switchNotifTab(cthN.tab || 'notif');
  }
  function switchNotifTab(tab) {
    cthN.tab = tab; cthN.thread = null;
    const p = document.getElementById('cth-notif-panel'); if (!p) return;
    p.querySelectorAll('.cth-ntab').forEach((t) => t.classList.toggle('active', (t.dataset.tab === tab)));
    if (tab === 'notif') loadNotifs(); else loadMemoThreads();
  }
  function setContent(html) { const c = document.getElementById('cth-notif-content'); if (c) { c.classList.remove('cth-conv-mode'); c.innerHTML = html; } return c; }

  /* ── 알림 탭 ── */
  async function loadNotifs() {
    if (!myKey()) { setContent('<div class="cth-nempty">로그인이 필요합니다.</div>'); return; }
    setContent('<div class="cth-nloading">불러오는 중…</div>');
    const resp = await apiFetch('notifs', {});
    if (!cthN.open || cthN.tab !== 'notif') return;
    const data = resp && resp.ok && resp.data;
    const list = (data && data.results) || [];
    if (!resp || !resp.ok) { setContent('<div class="cth-nempty">알림을 불러오지 못했습니다.</div>'); return; }
    if (!list.length) { setContent('<div class="cth-nempty">알림이 없습니다.</div>'); return; }
    const c = setContent('');
    for (const n of list) {
      const div = document.createElement('div');
      div.className = 'cth-nitem' + (n.read ? '' : ' unread');
      div.innerHTML = '<div class="cth-ntitle">' + nEsc(n.title || '') + '</div>' +
        '<div class="cth-ntext">' + nEsc(n.body || '') + '</div>' +
        '<div class="cth-ntime">' + nRel(n.created_at) + '</div>';
      div.addEventListener('click', () => onNotifClick(n));
      c.appendChild(div);
    }
  }
  async function onNotifClick(n) {
    const doRead = n && !n.read && n.id != null;
    // 낙관적 반영: 배지를 즉시 -1 하고 항목을 읽음 처리(서버 왕복을 기다리지 않아 체감 지연 제거)
    if (doRead) { n.read = true; bumpNotifBadge(-1); }
    // deep_link: lolwiki://post/<seq>?comment=<id>
    const m = /post\/(\d+)/.exec(String(n && n.deep_link || ''));
    if (m) { openPostFromNotif(m[1]); }              // 글로 이동(패널 닫힘) — 즉시 반응
    // 읽음 처리(POST)를 '기다린 뒤' 배지를 재계산해야 서버의 최신 unread_count가 반영된다.
    // await 없이 바로 refresh 하면 읽음 커밋 전의 옛 unread_count를 받아 배지가 텀을 두고 남는다.
    if (doRead) { try { await apiFetch('notifRead', { local_user_key: myKey(), notification_id: n.id }); } catch (e) {} }
    refreshNotifBadge();
  }
  function openPostFromNotif(postSeq) {
    closeNotifPanel();
    try { if (!W.g_lol_panel_show) { W.g_lol_panel_show = true; W.lol_panel_update(); } } catch (e) {}
    // 글 조회는 사이트가 처리한다(index_lol.js:389 와 동일한 요청)
    try { W.socket.emit('lol_get_article_detail', { post_seq: postSeq, android_id: W.g_lol_android_id }); } catch (e) {}
  }

  /* ── 채팅(쪽지) 탭 ── */
  async function loadMemoThreads() {
    if (!myKey()) { setContent('<div class="cth-nempty">로그인이 필요합니다.</div>'); return; }
    setContent('<div class="cth-nloading">불러오는 중…</div>');
    const resp = await apiFetch('memoThreads', { local_user_key: myKey() });
    if (!cthN.open || cthN.tab !== 'memo' || cthN.thread) return;
    const list = (resp && resp.ok && resp.data && resp.data.results) || [];
    if (!resp || !resp.ok) { setContent('<div class="cth-nempty">채팅을 불러오지 못했습니다.</div>'); return; }
    if (!list.length) { setContent('<div class="cth-nempty">주고받은 채팅이 없습니다.</div>'); return; }
    const c = setContent('');
    for (const t of list) {
      const div = document.createElement('div');
      div.className = 'cth-mthread';
      const unread = (t.unread_count > 0) ? '<span class="cth-munread">' + t.unread_count + '</span>' : '';
      div.innerHTML =
        '<img referrerpolicy="no-referrer" src="' + noRefImg(t.other_avatar_url) + '">' +
        '<div class="cth-mmain"><div class="cth-mnick">' + nEsc(t.other_nickname || '(알 수 없음)') + '</div>' +
        '<div class="cth-mlast">' + nEsc(t.last_body || (t.last_image_id ? '[이미지]' : '')) + '</div></div>' +
        '<div class="cth-mmeta"><span class="cth-mtime">' + nRel(t.last_message_at || t.updated_at) + '</span>' + unread + '</div>';
      div.addEventListener('click', () => openMemoThread(t));
      c.appendChild(div);
    }
  }

  async function openMemoThread(t) {
    cthN.thread = t;
    setContent('<div class="cth-nloading">불러오는 중…</div>');
    const resp = await apiFetch('memoThread', { thread_id: t.id, local_user_key: myKey() });
    if (!cthN.open || cthN.thread !== t) return;
    const data = resp && resp.ok && resp.data;
    const msgs = (data && (data.results || data.messages)) || [];
    const p = document.getElementById('cth-notif-content'); if (!p) return;
    p.classList.add('cth-conv-mode');   // #1 헤더/입력창 고정, 메시지 영역만 스크롤
    p.innerHTML =
      '<div class="cth-conv-head"><span class="cth-conv-back">←</span><span class="cth-conv-nick">' + nEsc(t.other_nickname || '') + '</span></div>' +
      '<div class="cth-conv-body" id="cth-conv-body"></div>' +
      '<div class="cth-conv-input"><input id="cth-conv-text" type="text" placeholder="메시지 입력" maxlength="1000"><button id="cth-conv-send">전송</button></div>';
    p.querySelector('.cth-conv-back').addEventListener('click', () => { cthN.thread = null; loadMemoThreads(); });
    renderMemoMessages(msgs);
    const input = p.querySelector('#cth-conv-text'), btn = p.querySelector('#cth-conv-send');
    const doSend = () => sendMemo(t, input, btn);
    btn.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend(); } });
    input.focus();
    refreshNotifBadge();
  }
  function renderMemoMessages(msgs) {
    const body = document.getElementById('cth-conv-body'); if (!body) return;
    body.innerHTML = '';
    const myId = W.__cthUserId;
    const t = cthN.thread || {};
    let prevDay = '', prevMine = null; // prevMine=false 면 직전이 상대(같은 그룹) → 아바타 생략
    for (const m of msgs) {
      const senderId = m.sender_user_id != null ? m.sender_user_id : m.sender_id;
      const mine = (myId != null && senderId != null && String(senderId) === String(myId));
      const day = nDay(m.created_at);
      if (day && day !== prevDay) {   // 날짜 바뀌면 중간에 구분선
        const sep = document.createElement('div');
        sep.className = 'cth-datesep';
        sep.innerHTML = '<span>' + nEsc(day) + '</span>';
        body.appendChild(sep);
        prevDay = day; prevMine = null;
      }
      const imgUrl = m.image_url || (m.image_id ? ('https://img.lolwiki.kr/i/' + m.image_id + '/resize') : '');
      const showAv = !mine && (prevMine !== false); // 상대 메시지 그룹의 첫 개면 아바타+꼬리
      const bubble = '<div class="cth-msg ' + (mine ? 'cth-mine' : 'cth-them') + (showAv ? ' cth-tail' : '') + '">' +
        (m.body ? nEsc(m.body) : '') +
        (imgUrl ? '<img referrerpolicy="no-referrer" src="' + nEsc(imgUrl) + '">' : '') +
        '<div class="cth-msgtime">' + nHM(m.created_at) + '</div></div>';
      const row = document.createElement('div');
      row.className = 'cth-msgrow ' + (mine ? 'cth-mine' : 'cth-them');
      if (mine) {
        row.innerHTML = bubble;
      } else {
        // 상대 메시지: 새 그룹이면 아바타, 연속이면 빈 자리로 정렬
        const av = showAv
          ? '<img class="cth-msgav" referrerpolicy="no-referrer" src="' + noRefImg(t.other_avatar_url) + '">'
          : '<div class="cth-msgav-sp"></div>';
        row.innerHTML = av + bubble;
      }
      body.appendChild(row);
      prevMine = mine;
    }
    body.scrollTop = body.scrollHeight;
  }
  async function sendMemo(t, input, btn) {
    const text = (input.value || '').trim(); if (!text) return;
    btn.disabled = true;
    const resp = await apiFetch('memoSend', { thread_id: t.id, local_user_key: myKey(), nickname: myNick(), body: text });
    btn.disabled = false;
    if (resp && resp.ok) { input.value = ''; const r2 = await apiFetch('memoThread', { thread_id: t.id, local_user_key: myKey() }); const data = r2 && r2.ok && r2.data; renderMemoMessages((data && (data.results || data.messages)) || []); }
    else { alert('전송 실패: ' + ((resp && resp.data && (resp.data.detail || resp.data.message)) || (resp && resp.status) || '오류')); }
  }

  /* ── 미읽음 배지 ── */
  // 배지 숫자를 서버 재조회 없이 즉시 delta 만큼 조정(낙관적 갱신). 다음 refreshNotifBadge()가 서버값으로 보정.
  function bumpNotifBadge(delta) {
    const b = document.getElementById('cth-notif-badge'); if (!b) return;
    let cur = parseInt(b.textContent, 10);
    if (!isFinite(cur)) cur = b.classList.contains('show') ? 1 : 0;
    const next = Math.max(0, cur + delta);
    if (next > 0) { b.textContent = next > 99 ? '99+' : String(next); b.classList.add('show'); }
    else { b.textContent = ''; b.classList.remove('show'); }
  }
  async function refreshNotifBadge() {
    if (!myKey()) return;
    let total = 0;
    try {
      const nr = await apiFetch('notifs', {});
      if (nr && nr.ok && nr.data) total += (nr.data.unread_count || 0);
      const mr = await apiFetch('memoThreads', { local_user_key: myKey() });
      if (mr && mr.ok && mr.data && mr.data.results) total += mr.data.results.reduce((a, t) => a + (t.unread_count || 0), 0);
    } catch (e) {}
    const b = document.getElementById('cth-notif-badge'); if (!b) return;
    if (total > 0) { b.textContent = total > 99 ? '99+' : String(total); b.classList.add('show'); }
    else { b.classList.remove('show'); }
  }

  /* ---------------- 고정짤 (내 글에 자동으로 붙는 이미지) ----------------
     신 API 는 고정짤을 유저 프로필의 fixed_image_id 로 관리한다.
     확장에서는 설정 메뉴에 '고정짤 등록/삭제'를 넣고, 등록 창에 이미지를 붙여넣기(Ctrl+V)하면
     JPEG 로 변환해 업로드한다. */
  function installFixedImageMenu() {
    const menu = document.getElementById('lol_lpanel_userinfo_menu_inner_background');
    if (!menu || document.getElementById('cth-fixedimg-set')) return;
    // '아이콘 제작' 바로 아래에 오도록, 그 다음 버튼(차단목록) 앞에 끼워 넣는다.
    const anchor = document.getElementById('lol_lpanel_userinfo_menu_button_blocklist_reset')
      || document.getElementById('lol_lpanel_userinfo_menu_button_api_logout')
      || document.getElementById('lol_lpanel_userinfo_menu_button_logout');
    const mk = (id, text, onClick) => {
      const b = document.createElement('div');
      b.id = id; b.setAttribute('menu-button', ''); b.textContent = text;
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const m = document.getElementById('lol_lpanel_userinfo_menu'); if (m) m.style.display = 'none';
        onClick();
      });
      if (anchor) menu.insertBefore(b, anchor); else menu.appendChild(b);
      return b;
    };
    mk('cth-fixedimg-set', '고정짤 등록', showFixedImageModal);
    mk('cth-fixedimg-del', '고정짤 삭제', clearFixedImage);
  }

  /* ---------------- 유저 차단 (글 상세의 '[차단하기]' 버튼) ----------------
     사이트의 차단 버튼은 아직 미구현(lol_onclick_auth_or_block 의 // TODO)이라, 확장이
     신 API로 처리한다. 차단 목록은 앱과 공유되므로 앱에도 그대로 반영된다. */
  async function handleBlockUser() {
    const d = W.g_lol_current_detail;
    if (!d || d.post_seq == null || s(d.post_seq).length === 0) return;
    if (!hasAuth()) { alert('차단하려면 자유게시판 로그인이 필요합니다.\n(글쓰기 등으로 한 번 로그인하면 자동으로 준비됩니다)'); return; }
    const nick = s(d.nickname);
    const authorId = s(d.author_id);
    if (d.my_post === '1' || isMyContent(authorId)) { alert('자신은 차단할 수 없습니다.'); return; }
    if (!W.confirm((nick || '이 사용자') + ' 님을 차단하시겠습니까?\n차단한 사용자의 글과 댓글은 보이지 않습니다.')) return;
    // 차단에는 대상의 숫자 user id 가 필요 → 신 글 상세의 author.id 로 해석
    const idr = await apiFetch('authorNumId', { post_seq: d.post_seq, author_id: authorId });
    if (!idr || !idr.ok || idr.author_id == null) { alert('차단 대상 정보를 확인하지 못했습니다.'); return; }
    const resp = await apiFetch('blockUser', { local_user_key: myKey(), blocked_user_id: idr.author_id, blocked: true });
    if (resp && resp.ok) {
      try { W.lol_onclick_aritcle_list_refresh(); } catch (e) {}   // offset 0 재조회 → 서버 차단목록 강제 갱신
      const back = document.getElementById('cth-board-back-detail'); // 컴팩트 모드: 목록으로 복귀
      if (back) back.click();
      setTimeout(() => alert((nick || '사용자') + ' 님을 차단했습니다.\n(설정 메뉴 → 차단목록 에서 해제할 수 있습니다)'), 30);
    } else {
      const why = (resp && (resp.error || (resp.data && (resp.data.detail || resp.data.message)) || resp.status)) || '오류';
      alert('차단 실패: ' + why);
    }
  }
  // 사이트가 index.js 에서 lol_rpanel_header_button.onclick = lol_onclick_auth_or_block(원본참조)로
  // 바인딩하므로, 그 버튼의 onclick 을 교체한다. 게스트(=로그인 요청)일 때는 원본을 그대로 호출.
  function ensureBlockButtonBound() {
    const btn = document.getElementById('lol_rpanel_header_button');
    if (!btn || btn.__cthBlockBound) return;
    btn.__cthBlockBound = true;
    btn.onclick = function (e) {
      if (!isGuest()) {
        if (e && e.preventDefault) e.preventDefault();
        handleBlockUser();
        return;
      }
      if (typeof W.lol_onclick_auth_or_block === 'function') return W.lol_onclick_auth_or_block.call(this, e);
    };
  }

  /* ---------------- 닉네임 변경 ----------------
     사이트 경로는 (1) 변경 전 24시간 제한을 알리지 않고, (2) 서버가 일부 실패 코드만 처리해
     제한에 걸려 거부돼도 아무 안내 없이 조용히 끝난다(확인만 되고 안 바뀐 것처럼 보임).
     → 확장이 변경 전 경고를 띄우고, 신 API 응답의 실제 사유를 그대로 보여준다. */
  function installNicknameChange() {
    const btn = document.getElementById('lol_lpanel_userinfo_menu_button_nickname_change');
    if (!btn || btn.__cthNickBound) return;
    btn.__cthNickBound = true;
    btn.onclick = function (e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      const menu = document.getElementById('lol_lpanel_userinfo_menu'); if (menu) menu.style.display = 'none';
      if (!hasAuth()) {   // 확장 인증이 없으면 사이트 기본 동작에 맡긴다
        if (typeof W.lol_onclick_userinfo_nickname_change === 'function') {
          try { return W.lol_onclick_userinfo_nickname_change.call(this, e); } catch (err) {}
        }
        alert('닉네임을 변경하려면 자유게시판 로그인이 필요합니다.');
        return;
      }
      doChangeNickname();
    };
  }
  async function doChangeNickname() {
    const cur = s(W.g_lol_user_info && W.g_lol_user_info.nickname);
    if (!W.confirm('닉네임을 변경하시겠습니까?\n\n※ 한 번 변경하면 24시간 동안 다시 변경할 수 없습니다.')) return;
    const input = W.prompt('새 닉네임을 입력하세요.\n(변경 후 24시간 동안 재변경 불가)', cur);
    if (input == null) return;                       // 취소
    const nick = s(input).trim();
    if (!nick) { alert('닉네임을 입력해 주세요.'); return; }
    if (nick === cur) { alert('현재 닉네임과 같습니다.'); return; }
    const resp = await apiFetch('changeNickname', { nickname: nick, local_user_key: myKey() });
    if (resp && resp.ok) {
      alert('닉네임이 "' + (resp.nickname || nick) + '" (으)로 변경되었습니다.\n24시간 동안은 다시 변경할 수 없습니다.');
      try { refreshMyProfile(); } catch (e) {}
      try { W.socket.emit('lol_user_info', W.g_lol_android_id); } catch (e) {}   // 사이트 표시 갱신
      try { W.lol_onclick_aritcle_list_refresh(); } catch (e) {}
    } else {
      // 서버가 알려주는 실제 사유를 그대로 보여준다(24시간 제한 등)
      const d = resp && resp.data;
      let why = (d && (d.message || d.detail || d.error))
        || (resp && (resp.error || (resp.status ? 'HTTP ' + resp.status : ''))) || '알 수 없는 오류';
      if (typeof why !== 'string') { try { why = JSON.stringify(why); } catch (e) { why = String(why); } }
      const limited = /24|하루|시간|limit|cooldown|too\s*many|429/i.test(why) || (resp && resp.status === 429);
      alert('닉네임 변경에 실패했습니다.\n\n사유: ' + why +
        (limited ? '\n\n닉네임은 변경 후 24시간이 지나야 다시 바꿀 수 있습니다.' : ''));
    }
  }

  /* ---------------- 차단목록 (앱 '내 정보 → 차단 관리'와 동일) ----------------
     사이트의 '차단목록 초기화' 버튼은 미구현('만들기 귀찮아서 유기')이라, 이름을 '차단목록'으로
     바꾸고 확장이 신 API로 목록 조회·개별 해제·일괄 해제를 처리한다. */
  function installBlockListMenu() {
    const btn = document.getElementById('lol_lpanel_userinfo_menu_button_blocklist_reset');
    if (!btn || btn.__cthBlockList) return;
    btn.__cthBlockList = true;
    btn.textContent = '차단목록';
    btn.onclick = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      const m = document.getElementById('lol_lpanel_userinfo_menu'); if (m) m.style.display = 'none';
      showBlockListModal();
    };
  }
  function closeBlockListModal() {
    const m = document.getElementById('cth-blocklist-modal'); if (m) m.remove();
  }
  async function showBlockListModal() {
    if (document.getElementById('cth-blocklist-modal')) return;
    if (!hasAuth()) { alert('차단목록을 보려면 자유게시판 로그인이 필요합니다.\n(글쓰기 등으로 한 번 로그인하면 자동으로 준비됩니다)'); return; }
    const dark = document.documentElement.getAttribute('theme') === 'dark';
    const ov = document.createElement('div');
    ov.id = 'cth-blocklist-modal';
    ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483100;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
    ov.innerHTML =
      '<div style="width:380px;max-width:100%;max-height:80vh;padding:20px;border-radius:10px;box-sizing:border-box;display:flex;flex-direction:column;font-size:14px;' +
        (dark ? 'background:#252525;color:#eee' : 'background:#fff;color:#222;box-shadow:0 8px 30px rgba(0,0,0,.3)') + '">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
          '<div style="font-size:17px;font-weight:bold">차단목록</div>' +
          '<div id="cth-blk-count" style="font-size:12px;color:#999"></div></div>' +
        '<div style="font-size:12px;color:#999;margin-bottom:10px">차단한 사용자의 글과 댓글은 보이지 않습니다.</div>' +
        '<div id="cth-blk-list" style="flex:1;overflow-y:auto;min-height:90px"></div>' +
        '<div id="cth-blk-status" style="font-size:12px;min-height:16px;margin-top:8px;color:#888"></div>' +
        '<div style="display:flex;gap:8px;justify-content:space-between;margin-top:10px">' +
          '<button id="cth-blk-clearall" style="padding:7px 14px;border:0;border-radius:6px;cursor:pointer;background:#e03131;color:#fff;font-weight:bold">전체 해제</button>' +
          '<button id="cth-blk-close" style="padding:7px 14px;border:0;border-radius:6px;cursor:pointer;background:#444;color:#ddd">닫기</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.querySelector('#cth-blk-close').onclick = closeBlockListModal;
    ov.addEventListener('click', (e) => { if (e.target === ov) closeBlockListModal(); });
    ov.querySelector('#cth-blk-clearall').onclick = unblockAll;
    await loadBlockList();
  }
  async function loadBlockList() {
    const list = document.getElementById('cth-blk-list');
    const cnt = document.getElementById('cth-blk-count');
    const clearAll = document.getElementById('cth-blk-clearall');
    if (!list) return;
    list.innerHTML = '<div style="padding:22px;text-align:center;color:#999;font-size:13px">불러오는 중…</div>';
    const resp = await apiFetch('blocks', { local_user_key: myKey() });
    if (!document.getElementById('cth-blocklist-modal')) return;
    if (!resp || !resp.ok) {
      list.innerHTML = '<div style="padding:22px;text-align:center;color:#e03131;font-size:13px">차단목록을 불러오지 못했습니다.</div>';
      return;
    }
    const rows = (resp.data && resp.data.results) || [];
    if (cnt) cnt.textContent = rows.length + '명' + (resp.data && resp.data.block_limit ? ' / 최대 ' + resp.data.block_limit + '명' : '');
    if (clearAll) clearAll.style.display = rows.length ? '' : 'none';
    if (!rows.length) {
      list.innerHTML = '<div style="padding:22px;text-align:center;color:#999;font-size:13px">차단한 사용자가 없습니다.</div>';
      return;
    }
    const dark = document.documentElement.getAttribute('theme') === 'dark';
    list.innerHTML = '';
    for (const b of rows) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid ' + (dark ? '#3a3a3a' : '#eee');
      row.innerHTML =
        '<img src="' + nEsc(mirrorUrl(b.avatar_url || '')) + '" style="width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;background:#888">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + nEsc(b.nickname || '(알 수 없음)') + '</div>' +
          // 앱과 동일하게 'N분전 차단'으로 보여주고, 정확한 시각은 마우스를 올리면 보이게 한다
          '<div style="font-size:11px;color:#999" title="' + nEsc(s(b.created_at).replace('T', ' ')) + '">' +
            nEsc(nRel(b.created_at) || '') + ' 차단</div>' +
        '</div>' +
        '<span class="cth-blk-un" style="cursor:pointer;color:#e03131;font-weight:bold;font-size:13px;flex-shrink:0">해제</span>';
      row.querySelector('.cth-blk-un').onclick = () => unblockOne(b);
      list.appendChild(row);
    }
  }
  async function unblockOne(b) {
    const status = document.getElementById('cth-blk-status');
    if (!W.confirm((b.nickname || '이 사용자') + ' 님의 차단을 해제할까요?\n해당 사용자의 글과 댓글이 다시 표시됩니다.')) return;
    if (status) { status.style.color = '#888'; status.textContent = '해제 중…'; }
    const resp = await apiFetch('blockUser', { local_user_key: myKey(), blocked_user_id: b.id, blocked: false });
    if (resp && resp.ok) {
      if (status) status.textContent = (b.nickname || '') + ' 님을 해제했습니다.';
      dropBlockedFromCache(b);
      await loadBlockList();
      try { W.lol_onclick_aritcle_list_refresh(); } catch (e) {}   // 목록 새로고침(다시 보이도록)
    } else if (status) {
      status.style.color = '#e03131';
      status.textContent = '해제 실패: ' + ((resp && (resp.error || resp.status)) || '오류');
    }
  }
  async function unblockAll() {
    const status = document.getElementById('cth-blk-status');
    const resp0 = await apiFetch('blocks', { local_user_key: myKey() });
    const rows = (resp0 && resp0.ok && resp0.data && resp0.data.results) || [];
    if (!rows.length) return;
    if (!W.confirm('차단한 ' + rows.length + '명을 모두 해제할까요?')) return;
    let done = 0, fail = 0;
    for (const b of rows) {
      if (status) { status.style.color = '#888'; status.textContent = '해제 중… (' + (done + fail + 1) + '/' + rows.length + ')'; }
      const r = await apiFetch('blockUser', { local_user_key: myKey(), blocked_user_id: b.id, blocked: false });
      if (r && r.ok) { done++; dropBlockedFromCache(b); } else fail++;
    }
    if (status) {
      status.style.color = fail ? '#e03131' : '#888';
      status.textContent = done + '명 해제 완료' + (fail ? (' · ' + fail + '명 실패') : '');
    }
    await loadBlockList();
    try { W.lol_onclick_aritcle_list_refresh(); } catch (e) {}
  }
  // 사이트가 캐시한 차단 목록에서도 즉시 제거(새로고침 전에도 글이 보이도록)
  function dropBlockedFromCache(b) {
    try {
      if (Array.isArray(W.g_lol_block_list)) {
        W.g_lol_block_list = W.g_lol_block_list.filter((x) => String(x && (x.id || x)) !== String(b.id));
      }
    } catch (e) {}
  }

  // 붙여넣은 이미지 파일 → JPEG base64 (사이트 글쓰기와 동일하게 캔버스로 변환)
  function pastedFileToJpeg(file, cb) {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1280;                                   // 과도한 용량 방지
        let w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { cb('', ''); return; }
        if (w > MAX || h > MAX) { const k = Math.min(MAX / w, MAX / h); w = Math.round(w * k); h = Math.round(h * k); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        const url = cv.toDataURL('image/jpeg', 0.92);
        cb(url.split(',')[1] || '', url);
      };
      img.onerror = () => cb('', '');
      img.src = fr.result;
    };
    fr.onerror = () => cb('', '');
    fr.readAsDataURL(file);
  }

  function closeFixedImageModal() {
    const m = document.getElementById('cth-fixedimg-modal'); if (m) m.remove();
  }
  function showFixedImageModal() {
    if (document.getElementById('cth-fixedimg-modal')) return;
    if (!hasAuth()) { alert('고정짤을 등록하려면 자유게시판 로그인이 필요합니다.\n(글쓰기 등으로 한 번 로그인하면 자동으로 준비됩니다)'); return; }
    const dark = document.documentElement.getAttribute('theme') === 'dark';
    const ov = document.createElement('div');
    ov.id = 'cth-fixedimg-modal';
    ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483100;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
    ov.innerHTML =
      '<div style="width:360px;max-width:100%;padding:20px;border-radius:10px;box-sizing:border-box;font-size:14px;' +
        (dark ? 'background:#252525;color:#eee' : 'background:#fff;color:#222;box-shadow:0 8px 30px rgba(0,0,0,.3)') + '">' +
        '<div style="font-size:17px;font-weight:bold;margin-bottom:8px">고정짤 등록</div>' +
        '<div style="font-size:12px;color:#999;margin-bottom:10px">이미지를 복사한 뒤 아래 영역을 클릭하고 <b>Ctrl+V</b> 로 붙여넣으세요.</div>' +
        '<div id="cth-fixedimg-drop" tabindex="0" style="height:190px;border:2px dashed ' + (dark ? '#555' : '#ccc') +
          ';border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;outline:none;' +
          'color:#999;font-size:13px;text-align:center">붙여넣기 대기 중…</div>' +
        '<div id="cth-fixedimg-status" style="font-size:12px;min-height:16px;margin-top:8px;color:#888"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">' +
          '<button id="cth-fixedimg-cancel" style="padding:7px 14px;border:0;border-radius:6px;cursor:pointer;background:#444;color:#ddd">취소</button>' +
          '<button id="cth-fixedimg-ok" style="padding:7px 14px;border:0;border-radius:6px;cursor:pointer;background:#339af0;color:#fff;font-weight:bold" disabled>등록</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    const drop = ov.querySelector('#cth-fixedimg-drop');
    const status = ov.querySelector('#cth-fixedimg-status');
    const okBtn = ov.querySelector('#cth-fixedimg-ok');
    let b64 = '';
    drop.focus();
    ov.querySelector('#cth-fixedimg-cancel').onclick = closeFixedImageModal;
    ov.addEventListener('click', (e) => { if (e.target === ov) closeFixedImageModal(); });
    drop.addEventListener('click', () => drop.focus());

    const onPaste = (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.indexOf('image') === 0) {
          e.preventDefault();
          status.style.color = '#888'; status.textContent = '이미지 읽는 중…';
          pastedFileToJpeg(it.getAsFile(), (data, url) => {
            if (!data) { status.style.color = '#e03131'; status.textContent = '이미지를 읽지 못했습니다.'; return; }
            b64 = data; okBtn.disabled = false;
            drop.innerHTML = '<img src="' + url + '" style="max-width:100%;max-height:100%;object-fit:contain">';
            status.style.color = '#888';
            status.textContent = '붙여넣기 완료 (' + Math.round(data.length * 3 / 4 / 1024) + 'KB) — [등록]을 누르세요.';
          });
          return;
        }
      }
      status.style.color = '#e03131'; status.textContent = '클립보드에 이미지가 없습니다.';
    };
    document.addEventListener('paste', onPaste, true);
    // 모달이 사라지면 paste 리스너도 정리
    new MutationObserver((ms, obs) => {
      if (!document.getElementById('cth-fixedimg-modal')) { document.removeEventListener('paste', onPaste, true); obs.disconnect(); }
    }).observe(document.body, { childList: true });

    okBtn.onclick = async () => {
      if (!b64) return;
      okBtn.disabled = true; status.style.color = '#888'; status.textContent = '등록 중…';
      const resp = await apiFetch('fixedImage', { image: b64, local_user_key: myKey() });
      if (resp && resp.ok) {
        closeFixedImageModal();
        setTimeout(() => alert('고정짤이 등록되었습니다.'), 30);
      } else {
        okBtn.disabled = false;
        status.style.color = '#e03131';
        status.textContent = '등록 실패: ' + ((resp && (resp.error || (resp.data && (resp.data.detail || resp.data.message)) || resp.status)) || '오류');
      }
    };
  }
  async function clearFixedImage() {
    if (!hasAuth()) { alert('고정짤을 삭제하려면 자유게시판 로그인이 필요합니다.'); return; }
    if (!W.confirm('등록된 고정짤을 삭제하시겠습니까?')) return;
    const resp = await apiFetch('fixedImage', { clear: true, local_user_key: myKey() });
    if (resp && resp.ok) alert('고정짤이 삭제되었습니다.');
    else alert('고정짤 삭제 실패: ' + ((resp && (resp.error || (resp.data && (resp.data.detail || resp.data.message)) || resp.status)) || '오류'));
  }

  // socket / 렌더 함수가 준비될 때까지 대기 후 설치
  let tries = 0;
  const timer = setInterval(() => {
    wrapRenderFns();
    try { installAuth(); } catch (e) {}
    try { installNotificationCenter(); } catch (e) {}
    try { installFixedImageMenu(); } catch (e) {}
    try { installBlockListMenu(); } catch (e) {}
    try { installNicknameChange(); } catch (e) {}
    try { installReplyGifCapture(); } catch (e) {}
    try { installWriteImages(); } catch (e) {}
    const done = wrapSocket();
    if ((done && W.lol_lpanel_update && W.lol_lpanel_update.__cthWrapped) || ++tries > 100) {
      clearInterval(timer);
    }
  }, 200);
})();
