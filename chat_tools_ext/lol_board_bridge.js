/* lol_board_bridge.js — MAIN world content script
 *
 * 자유게시판 백엔드가 2026-07-19 04:00:23에 신 REST API로 이전되면서,
 * DJ 서버가 중계하던 구 lolwiki.kr PHP 엔드포인트가 동결됨
 *  → 신규 글이 안 보이고 댓글이 사라지는 문제 발생.
 *
 * 이 스크립트는 페이지의 socket.emit(자유게시판 요청)을 가로채,
 * DJ 서버 대신 신 API(https://lolwiki.kr/api/app/api/v1)에서 직접 읽어와
 * 서버가 만들던 것과 동일한 데이터 형태로 페이지의 렌더 함수를 호출한다.
 *  - fetch 자체는 CORS 우회를 위해 background(=relay 경유)에서 수행
 *  - 신 API는 이미지/아바타를 전체 https URL로 주는데, 구 렌더는 파일명→URL 조립이라
 *    렌더 직후 DOM에서 해당 <img> src를 실제 URL로 교체(fixup)한다.
 *
 * 대상: lol_get_article_list(목록), lol_get_article_detail(글+댓글)  — 읽기 전용.
 * 글/댓글 작성(쓰기)은 신원 확보가 필요해 아직 미포함(추후).
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
  function fmtDateTime(iso) {
    if (!iso) return '';
    const m = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
    return m ? (m[1] + ' ' + m[2]) : s(iso).slice(0, 16).replace('T', ' ');
  }
  // 목록/댓글 시간 표기:
  //  · 1분 미만 → 'N초 전'
  //  · 1분 이상 1시간 미만 → 'N분 전' (날짜가 달라도 우선)
  //  · 1시간 이상 + 오늘(같은 날짜) → 'HH:MM' (24시간)
  //  · 그 외 → 'YYYY-MM-DD'
  // created_at 은 KST(UTC+9) naive 이므로 +09:00 로 절대시각 환산해 지금과 비교(브라우저 TZ 무관).
  function fmtRelTime(iso) {
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
    const wrap = (t, color, bold) =>
      '<font color=' + color + ' size=1>' + (bold ? '<b style="font-weight:800">' + t + '</b>' : t) + '</font>';
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s(iso));
    if (!m) return s(iso) ? wrap(s(iso).slice(0, 10), C_DATE, false) : '';
    const Y = m[1], Mo = m[2], D = m[3], H = m[4], Mi = m[5], Sec = m[6] || '00';
    const createdEpoch = Date.parse(Y + '-' + Mo + '-' + D + 'T' + H + ':' + Mi + ':' + Sec + '+09:00');
    const diffSec = Math.floor((Date.now() - createdEpoch) / 1000);
    const diffMin = Math.floor(diffSec / 60);
    if (diffSec <= 3) return wrap('now', C_NOW, true);              // 방금(3초 이내)
    if (diffSec < 60) return wrap(diffSec + '초 전', C_SEC, true);
    if (diffMin < 60) return wrap(diffMin + '분 전', C_MIN, true);
    // 지금(KST) 날짜와 같은 날이면 시:분(분 전과 같은 색), 아니면 날짜(회색·보통)
    const nk = new Date(Date.now() + 9 * 3600 * 1000);
    if (nk.getUTCFullYear() === +Y && (nk.getUTCMonth() + 1) === +Mo && nk.getUTCDate() === +D) {
      return wrap(H + ':' + Mi, C_MIN, true);
    }
    return wrap(Y + '-' + Mo + '-' + D, C_DATE, false);   // 회색·보통
  }
  // 사이트가 글 본문 끝에 붙이는 'DJ로 작성' 숨김 워터마크. 구 백엔드는 응답 시 제거했으나
  // 신 API는 그대로 반환하므로 표시에서 떼어낸다.
  function stripDjMarker(text) {
    return text ? String(text).replace(/\s*<ㄹㅗㄹㄷㅣ>/g, '') : text;
  }
  function imageUrlsOf(p) {
    if (Array.isArray(p.image_urls) && p.image_urls.length) return p.image_urls.slice(0, 4);
    if (p.image_url) return [p.image_url];
    return [];
  }

  // 글/댓글의 author_id 가 내 식별자(local_user_key/legacy_id/android/device 중 하나)와 일치하면 내 것.
  // (legacy 계정은 author_id 가 legacy_id 형식이라 local_user_key 와 다름 → 여러 식별자를 모두 비교)
  function isMyContent(authorId) {
    if (!authorId) return false;
    const ids = W.__cthMyIds || [];
    for (let i = 0; i < ids.length; i++) if (ids[i] === authorId) return true;
    return false;
  }

  /* ---------------- 차단(모바일 앱에서 차단한 유저) ----------------
     신 API GET /blocks 는 {id(숫자 user id), nickname, avatar_url} 를 준다.
     - 견고한 매칭은 '숫자 user id'. 하지만 게시판 표시는 legacy-read-compat(author_id=문자열)라
       숫자 id가 없으므로, 모던 엔드포인트(/board/posts, /board/posts/{id}/comments)를 병렬로
       보강해 각 글/댓글의 숫자 author id를 얻어 매칭한다(legacy_post_seq / comment_seq 로 조인).
     - 조인이 불가한 항목(깊은 페이지·작성자별 목록 등)은 '닉네임'으로 폴백 매칭한다. */
  let _blocksAt = 0, _blocksInFlight = null;
  const CTH_LEGACY_CSEQ_OFFSET = 1000000000;   // legacy comment_seq = 모던 댓글 id + 10억
  function isBlockedById(numId) {
    const set = W.__cthBlockedIds;
    return !!(set && set.size && numId != null && numId !== '' && set.has(String(numId)));
  }
  function isBlockedByNick(nick) {
    const set = W.__cthBlockedNicks;
    const n = s(nick).trim();
    return !!(set && set.size && n && set.has(n));
  }
  // 숫자 id를 알면 그걸로만 판정(정확 — 동일 닉 다른 유저 오판 방지), 모르면 닉네임 폴백.
  function isBlocked(numId, nick) {
    if (numId != null && numId !== '') return isBlockedById(numId);
    return isBlockedByNick(nick);
  }
  async function loadBlocks(force) {
    const key = W.__cthLocalUserKey;
    if (!key) { W.__cthBlockedIds = new Set(); W.__cthBlockedNicks = new Set(); return; }
    const fresh = W.__cthBlockedIds && (Date.now() - _blocksAt < 30000);
    if (!force && fresh) return;
    if (_blocksInFlight) return _blocksInFlight;         // 동시 호출 합치기
    _blocksInFlight = (async () => {
      try {
        const resp = await apiFetch('blocks', { local_user_key: key });
        const ids = new Set(), nicks = new Set();
        if (resp && resp.ok && resp.data && Array.isArray(resp.data.results)) {
          for (const b of resp.data.results) {
            if (b && b.id != null) ids.add(String(b.id));
            const n = s(b && b.nickname).trim(); if (n) nicks.add(n);
          }
        }
        W.__cthBlockedIds = ids; W.__cthBlockedNicks = nicks; _blocksAt = Date.now();
      } catch (e) { /* 실패 시 이전 값 유지 */ } finally { _blocksInFlight = null; }
    })();
    return _blocksInFlight;
  }
  // 모던 목록에서 legacy_post_seq → 숫자 author id 맵을 만든다(조인 가능한 목록 모드에서만).
  async function fetchPostAuthorIdMap(params) {
    // 모던 /board/posts 는 q·nickname·mode 만 지원(author_id·offset 미지원) → 첫 페이지·검색·인기만 조인
    if (params.author_id || (params.offset || 0) !== 0) return null;
    try {
      const mp = { limit: params.limit || 30 };
      if (params.q) mp.q = params.q;
      if (params.nickname) mp.nickname = params.nickname;
      if (params.mode) mp.mode = params.mode;
      const resp = await apiFetch('listModern', mp);
      if (!resp || !resp.ok || !resp.data || !Array.isArray(resp.data.results)) return null;
      const map = {};
      for (const m of resp.data.results) {
        const seq = m && m.legacy_post_seq, aid = m && m.author && m.author.id;
        if (seq != null && aid != null) map[String(seq)] = String(aid);
      }
      return map;
    } catch (e) { return null; }
  }
  // 모던 댓글에서 legacy comment_seq → 숫자 author id 맵을 만든다.
  async function fetchCommentAuthorIdMap(post, postSeq) {
    try {
      const modernId = await resolvePostId(post, postSeq);
      if (!modernId) return null;
      const resp = await apiFetch('commentsById', { id: modernId });
      if (!resp || !resp.ok || !resp.data || !Array.isArray(resp.data.results)) return null;
      const map = {};
      for (const m of resp.data.results) {
        if (m && m.id != null && m.author_id != null) map[String(m.id + CTH_LEGACY_CSEQ_OFFSET)] = String(m.author_id);
      }
      return map;
    } catch (e) { return null; }
  }

  /* ---------------- 신 API → 구 클라이언트 데이터 매핑 ---------------- */
  // 구 목록 아이템 형태(8080.js lol_get_article_list의 반환 형태)에 맞춘다.
  function mapListItem(p) {
    return {
      post_seq: s(p.post_seq),
      icon_img: '', badge_use: '',          // 아바타는 fixup으로 교체
      post_title: s(p.title),
      reply_cnt: p.comments || 0,
      before: fmtRelTime(p.created_at),      // 목록 시간 표기(분 전 / HH:MM / 날짜)
      post_date: s(p.created_at),
      nickname: s(p.author),
      views: p.views || 0,
      likes: p.likes || 0,
      alarm: p.report_count || 0,
      youtube_url: s(p.youtube_url),
      doodlr: 0,
      pic_new: p.has_image ? '1' : '',       // 렌더는 length만 확인(짤 아이콘 표시용)
      pic_multi: '',
      fixedpic: '',
      __cthAvatar: s(p.avatar_url),
      __cthAuthorId: s(p.author_id)
    };
  }
  // 구 상세 형태(lol_rpanel_update가 읽는 필드)
  function mapDetail(p, replys, newId) {
    return {
      post_seq: s(p.post_seq),
      post_title: s(p.title),
      post_text: stripDjMarker(s(p.body)),
      post_date: s(p.created_at),
      likes: p.likes || 0,
      views: p.views || 0,
      nickname: s(p.author),
      stack: s(p.author_stack_count),
      youtube_url: s(p.youtube_url),
      icon_img: '', badge_use: '',
      pic_new: '', pic_multi: '', doodlr: 0, fixedpic: '',  // 이미지는 fixup
      // 내 글이면 삭제 버튼 노출: 서버 is_mine 우선, 없으면 author_id를 내 식별자들과 비교. 사이트는 '1' 문자열 비교
      my_post: (p.is_mine || isMyContent(s(p.author_id))) ? '1' : '',
      replys: replys || [],
      __cthOurs: true,                 // fixupDetail 이 우리 상세임을 판별 (아바타 없어도 장식 실행)
      __cthAvatar: s(p.avatar_url),
      __cthImages: imageUrlsOf(p),
      __cthAuthorId: s(p.author_id),
      __cthNewId: newId || null
    };
  }
  // 신 댓글 엔드포인트(/board/posts/{id}/comments) 응답 → 구 reply 형태
  function mapNewComment(c) {
    const hidden = c.status && c.status !== 'active' && c.status !== 'normal' && c.status !== 'visible';
    return {
      reply_seq: s(c.id),
      icon_img: '', badge_use: '',
      nickname: s(c.nickname),
      reply_date: fmtRelTime(c.created_at),
      my_post: 0,
      reply_img: c.image_url ? '1' : '',
      reply_title: hidden ? '<i>삭제된 댓글입니다.</i>' : decorateMentions(stripDjMarker(s(c.body))),
      __cthAvatar: s(c.avatar_url),
      __cthImage: s(c.image_url)
    };
  }
  // 본문의 '@닉네임' 멘션을 파란 하이라이트 스팬으로 감싸 플레인 텍스트와 시각적으로 구분한다.
  // 나머지 본문은 그대로 두고(<,> 는 건너뛰어 기존 HTML을 깨지 않음) 멘션 토큰만 감싼다.
  // (댓글은 index_lol.js에서 text.innerHTML = reply_title 로 렌더되므로 스팬이 그대로 적용됨)
  function decorateMentions(body) {
    if (!body) return body;
    return String(body).replace(/(^|[\s(])@([^\s@<>]{1,30})/g,
      function (m, pre, nick) { return pre + '<span class="cth-mention">@' + nick + '</span>'; });
  }
  // 구 댓글 형태(lol_rpanel_update 댓글 렌더가 읽는 필드)
  function mapReply(c) {
    return {
      reply_seq: s(c.comment_seq),
      icon_img: '', badge_use: '',
      nickname: s(c.author),
      reply_date: fmtRelTime(c.created_at),
      // 서버 is_mine 우선, 없으면 author_id를 내 식별자들과 비교(legacy_id 등)
      my_post: (c.is_mine || isMyContent(s(c.author_id))) ? 1 : 0,
      reply_img: c.image_url ? '1' : '',     // length만 확인 → 실제 src는 fixup
      reply_title: c.deleted ? '<i>삭제된 댓글입니다.</i>' : decorateMentions(s(c.body)),
      __cthAvatar: s(c.avatar_url),
      __cthImage: s(c.image_url),
      __cthParent: c.parent_id,             // 0/없음=일반 댓글, 그 외=답글 대상 comment_seq
      __cthAuthorId: s(c.author_id)
    };
  }

  /* ---------------- 답글(parent_id) 스레드 정렬 + 답글 작성 UI ---------------- */
  // 답글을 부모 댓글 바로 아래로 정렬하고 깊이(__cthDepth)를 매긴다.
  function threadReplies(arr) {
    const bySeq = {}, children = {}, roots = [];
    arr.forEach((r) => { bySeq[s(r.reply_seq)] = r; });
    arr.forEach((r) => {
      const pid = r.__cthParent;
      if (pid && s(pid) !== '0' && bySeq[s(pid)]) (children[s(pid)] = children[s(pid)] || []).push(r);
      else roots.push(r);
    });
    const out = [];
    (function walk(list, depth) {
      for (const r of list) { r.__cthDepth = depth; out.push(r); if (children[s(r.reply_seq)]) walk(children[s(r.reply_seq)], depth + 1); }
    })(roots, 0);
    return out;
  }

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
  // restoreWriteToBottom()으로 맨 아래(원위치)에 두고, 렌더 후에만 이 함수로 대상 아래로 옮긴다.
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
      else restoreWriteToBottom();       // 대상 항목을 못 찾으면 맨 아래에서라도
      showReplyBar();                    // 어느 경우든 답글 바 표시(대상 명시)
    } else {
      restoreWriteToBottom();
      const bar = document.getElementById('cth-board-reply-bar'); if (bar) bar.remove();
    }
  }
  function showReplyBar() {
    const cont = document.getElementById('lol_rpanel_reply_board_write_container');
    if (!cont || !cont.parentElement) return;
    // ID/클래스는 content.js 채팅 답장 UI('cth-reply-bar'/'cth-reply-cancel')와 충돌하지 않게 'cth-board-' 접두
    let bar = document.getElementById('cth-board-reply-bar');
    if (!bar) bar = document.createElement('div');
    bar.id = 'cth-board-reply-bar';
    // 바를 항상 입력창 바로 앞(=대상 댓글과 입력창 사이)에 위치시킨다
    cont.parentElement.insertBefore(bar, cont);
    // cssText로 매번 재설정(다른 스타일시트 규칙에 눌리지 않도록 display도 명시)
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;font-size:12px;color:#ccc;background:rgba(51,154,240,.13);border-radius:6px;margin:0 5px 4px';
    bar.innerHTML = '<span>↳ <b>' + nEsc(cthReply.nick) + '</b> 님에게 답글</span>' +
      '<span id="cth-board-reply-cancel" style="cursor:pointer;color:#e03131;font-weight:bold">✕ 취소</span>';
    const cancel = document.getElementById('cth-board-reply-cancel'); if (cancel) cancel.onclick = clearReplyTarget;
  }
  // 신모드에서 렌더된 모든 댓글에 '답글' 버튼(+ 스레드 들여쓰기)을 주입.
  // __cthOurs 게이트와 무관하게 lol_rpanel_update 마다 항상 실행되므로 어떤 상태든 버튼이 유지된다.
  function decorateAllReplies() {
    if (document.documentElement.dataset.cthNewBoard === '0') return;
    const rlist = document.getElementById('lol_rpanel_reply_board_list');
    if (!rlist) return;
    const bySeq = {};
    const d = W.g_lol_current_detail;
    if (d && Array.isArray(d.replys)) for (const r of d.replys) if (r) bySeq[s(r.reply_seq)] = r;
    for (const item of rlist.querySelectorAll('.lol_reply_list_item')) {
      const seq = item.getAttribute('seq');
      const r = bySeq[seq];
      if (r) {   // 우리 데이터가 있으면 스레드 깊이만큼 들여쓰기
        const depth = Math.min(r.__cthDepth || 0, 4);
        item.style.marginLeft = (depth * 22) + 'px';
        if (depth > 0) { item.style.borderLeft = '2px solid var(--롤백_보더색)'; item.style.paddingLeft = '8px'; item.style.boxSizing = 'border-box'; }
      }
      const nc = item.querySelector('[nick_container]');
      // 클래스명은 content.js의 채팅 답장 버튼 '.cth-reply-btn'(display:none)과 충돌하지 않게 별도로 사용
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

  /* ---------------- 렌더 직후 이미지/아바타 DOM 교정 ---------------- */
  function fixupList() {
    // 로그인한 내 계정 아이콘도 no-referrer로 교정 (신 API 아바타)
    if (W.g_lol_user_info && W.g_lol_user_info.__cthAvatar) {
      setImg(document.getElementById('lol_lpanel_account_icon'), W.g_lol_user_info.__cthAvatar);
    }
    const list = W.g_lol_article_list;
    const board = document.getElementById('lol_lpanel_board_list');
    if (!Array.isArray(list) || !board) return;
    const bySeq = {};
    for (const e of list) if (e && e.__cthAvatar) bySeq[s(e.post_seq)] = e.__cthAvatar;
    for (const item of board.querySelectorAll('.lol_article_list_item')) {
      const av = bySeq[item.getAttribute('seq')];
      if (!av) continue;                     // 우리 데이터가 아닌 항목(북마크 등)은 건너뜀
      setImg(item.querySelector('img[icon]'), av);
    }
  }
  function fixupDetail() {
    const d = W.g_lol_current_detail;
    if (!d || !d.__cthOurs) return;          // 우리가 채운 상세일 때만 (아바타 유무와 무관)
    // 내 글에는 '[차단하기]'(=자신 차단) 숨김
    const bb = document.getElementById('lol_rpanel_header_button');
    if (bb) bb.style.display = (d.my_post === '1') ? 'none' : '';
    setImg(document.getElementById('lol_rpanel_header_icon'), d.__cthAvatar);
    // #3 공유 버튼 아이콘: 사이트 렌더(lol_get_icon_url('') → 흰 이미지)를 덮어써
    // 실제 글쓴이 아바타의 미러 URL로 지정한다. 채팅 공유 카드는 icon_img를
    // lol_convert_uri_to_mirror(=https 통과)로 그대로 로드하므로 모두에게 정상 표시된다.
    if (d.__cthAvatar) {
      const shareBtn = document.getElementById('lol_rpanel_body_share_button');
      if (shareBtn) shareBtn.setAttribute('icon_img', mirrorUrl(d.__cthAvatar));
    }
    // 본문 이미지 (최대 4칸)
    const imgs = Array.isArray(d.__cthImages) ? d.__cthImages : [];
    for (let k = 1; k <= 4; k++) {
      const cont = document.getElementById('lol_rpanel_body_img' + k);
      const im = document.getElementById('lol_rpanel_body_img' + k + '_img');
      const add = document.getElementById('lol_rpanel_body_img' + k + '_add');
      if (!cont || !im) continue;
      if (k <= imgs.length) {
        cont.style.display = 'block';
        setImg(im, imgs[k - 1]);
        if (add) add.setAttribute('src', mirrorUrl(imgs[k - 1]));
      }
      // k > imgs.length 인 칸은 렌더가 이미 숨김 처리함
    }
    // 댓글 아바타/이미지
    const rlist = document.getElementById('lol_rpanel_reply_board_list');
    if (rlist && Array.isArray(d.replys)) {
      const bySeq = {};
      for (const r of d.replys) if (r) bySeq[s(r.reply_seq)] = r;
      for (const item of rlist.querySelectorAll('.lol_reply_list_item')) {
        const r = bySeq[item.getAttribute('seq')];
        if (!r) continue;
        setImg(item.querySelector('img[icon]'), r.__cthAvatar);
        if (r.__cthImage) setImg(item.querySelector('img[img]'), r.__cthImage);
      }
    }
  }

  /* ---------------- 요청 인터셉트 핸들러 ---------------- */
  let _origEmit = null;

  async function handleList(req) {
    req = req || {};
    const params = { limit: req.cnt || 30, offset: req.seq || 0 };
    const aid = req.android_id;
    if (typeof aid === 'string' && aid.indexOf('cth-author:') === 0) {
      params.author_id = aid.slice('cth-author:'.length);       // 닉네임→작성자 글
    } else if (req.mine) {
      const nick = (W.g_lol_user_info && W.g_lol_user_info.nickname) || '';
      if (nick) params.nickname = nick;                          // 내 글 (닉네임 필터)
      else { _origEmit('lol_get_article_list', req); return; }
    } else if (req.nick && req.nick.length) {
      params.nickname = req.nick;                                 // 닉네임 검색
    } else if (req.body && req.body.length) {
      params.q = req.body;                                        // 키워드 검색
    } else if (req.vote) {
      params.mode = 'popular';                                    // 인기글(추천순)
    }
    const listP = apiFetch('list', params);
    // 새 목록(offset 0 = 새로고침 버튼·최초 로드·검색 등)에서는 차단 목록을 강제 갱신 →
    // 앱에서 차단/해제한 게 새로고침 시 바로 반영. 스크롤 페이지네이션(offset>0)은 캐시 유지.
    await loadBlocks((req.seq || 0) === 0);
    const hasBlocks = (W.__cthBlockedIds && W.__cthBlockedIds.size) || (W.__cthBlockedNicks && W.__cthBlockedNicks.size);
    // 차단이 있을 때만 모던 목록으로 숫자 author id 맵을 보강(불필요한 요청 방지)
    const postAuthorMap = hasBlocks ? await fetchPostAuthorIdMap(params) : null;
    const resp = await listP;
    if (!resp || !resp.ok || !resp.data || !Array.isArray(resp.data.results)) {
      log('list fetch 실패, 서버 폴백', resp && resp.error);
      _origEmit('lol_get_article_list', req);
      return;
    }
    const rawResults = resp.data.results;
    // 차단 유저의 글은 숨긴다: 모던 조인으로 얻은 숫자 id 우선, 없으면 닉네임 폴백.
    // 표시만 제외하고 페이지 커서는 서버 반환 기준 유지.
    const results = rawResults.filter(r => {
      if (!r) return false;
      const numId = postAuthorMap ? postAuthorMap[String(r.post_seq)] : undefined;
      return !isBlocked(numId, r.author);
    });
    const mapped = results.map(mapListItem);
    // offset=0 에서 API가 공지글을 맨 앞에 하나 더 얹어줘(limit+1개) 반환한다.
    // 페이지네이션 커서는 '공지 제외' 개수만큼 전진시켜야 다음 페이지에서 글이 누락되지 않는다.
    // (차단 필터로 화면 개수가 줄어도 커서는 서버가 실제 반환한 개수만큼 전진해야 페이지 누락이 없다)
    const nonNotice = rawResults.filter(r => !r.notice).length;
    W.g_lol_article_scroll_seq = (req.seq || 0) + nonNotice;
    W.g_lol_article_list = (W.g_lol_article_list || []).concat(mapped);
    W.lol_lpanel_update();                    // 래핑됨 → fixupList 자동 호출
    const rf = document.getElementById('lol_lpanel_refresh'); if (rf) rf.style.height = '38px';
    const sm = document.getElementById('lol_lpanel_search_menu'); if (sm) sm.style.display = 'none';
    if (W.g_lol_lpanel_scroll_top_switch) {
      W.g_lol_lpanel_scroll_top_switch = false;
      const b = document.getElementById('lol_lpanel_board'); if (b) b.scroll(0, 0);
    }
  }

  const _idCache = {};   // 구 post_seq → 신 post id
  async function resolvePostId(post, postSeq) {
    if (_idCache[postSeq]) return _idCache[postSeq];
    const authorId = post && post.author_id;
    if (!authorId) return null;
    const rr = await apiFetch('resolveId', { author_id: authorId, post_seq: postSeq });
    if (rr && rr.ok && rr.id) { _idCache[postSeq] = rr.id; return rr.id; }
    return null;
  }

  // 상세 로딩 표시(클릭 즉시 반응). 사이트 DOM을 건드리지 않도록 body에 고정 위치 오버레이로 띄운다.
  function showDetailLoading(on) {
    let el = document.getElementById('cth-detail-loading');
    if (!on) { if (el) el.remove(); return; }
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

  // 댓글 영역 전용 '댓글 불러오는 중…' 표시(본문 먼저 뜬 뒤 느린 댓글을 기다리는 동안).
  function showCommentsLoading(on) {
    let el = document.getElementById('cth-comments-loading');
    if (!on) { if (el) el.remove(); return; }
    const list = document.getElementById('lol_rpanel_reply_board_list');
    if (!list) return;
    if (!el) { el = document.createElement('div'); el.id = 'cth-comments-loading'; el.textContent = '댓글 불러오는 중…'; }
    const dark = document.documentElement.getAttribute('theme') === 'dark';
    el.style.cssText = 'padding:14px;text-align:center;font-size:12px;color:' + (dark ? '#aaa' : '#888');
    list.appendChild(el);
  }
  const _delay = (ms) => new Promise((r) => setTimeout(r, ms));
  // g_lol_current_detail 세팅 + 사이트 렌더(index_socket.js의 lol_article_detail 핸들러와 동일).
  function applyDetail(mapped) {
    const prev = W.g_lol_current_detail;
    W.g_lol_same_article_prev = !!(prev && prev.post_seq == mapped.post_seq);
    if (!W.g_lol_same_article_prev) clearReplyTarget();   // 다른 글로 이동할 때만 답글 대상 리셋
    W.g_lol_current_detail = mapped;
    try { W.lol_write_panel_toggle(false); } catch (e) {}
    const rf = document.getElementById('lol_rpanel_refresh'); if (rf) rf.style.display = 'block';
    W.lol_rpanel_update();                    // 래핑됨 → fixupDetail 자동 호출
  }

  let _detailToken = 0;                       // 상세 요청 세대 토큰(늦게 온 응답이 최신 화면을 덮지 않게)
  async function handleDetail(req) {
    req = req || {};
    if (req.post_seq == null || s(req.post_seq).length === 0) return;
    const token = ++_detailToken;
    showDetailLoading(true);                   // 클릭 즉시 '불러오는 중…' 표시(수 초 무반응 체감 제거)
    // 본문(제목/내용)과 댓글을 동시에 요청하되 서로를 기다리지 않는다.
    // 옛 이미지 글은 서버가 '댓글'을 만드는 데 수 초 걸리기도 하므로(본문은 즉시), 본문을 먼저 띄운다.
    const detailP = apiFetch('detail', { post_seq: req.post_seq });
    // 댓글은 구 저장소(legacy-read-compat/comments)에서 읽는다 — 앱과 동일 저장소(legacy-write 댓글 포함).
    const commentsP = apiFetch('comments', { post_seq: req.post_seq });

    const dResp = await detailP;
    if (token !== _detailToken) return;        // 그 사이 다른 글 클릭 → 폐기(최신 요청이 로딩 표시 소유)
    if (!dResp || !dResp.ok || !dResp.data || !dResp.data.post) {
      showDetailLoading(false);
      log('detail fetch 실패, 서버 폴백', dResp && dResp.error);
      _origEmit('lol_get_article_detail', req);
      return;
    }
    const post = dResp.data.post;

    // 댓글이 곧 오면(빠른 글) 본문·댓글을 한 번에 렌더(깜빡임 없음),
    // 늦으면(느린 글) 본문을 먼저 렌더하고 댓글은 오는 대로 채운다.
    let cr = await Promise.race([commentsP, _delay(350).then(() => '__slow__')]);
    if (token !== _detailToken) return;
    if (cr === '__slow__') {
      applyDetail(mapDetail(post, []));        // 제목/내용 먼저 표시
      showDetailLoading(false);
      showCommentsLoading(true);               // 댓글 영역에만 '불러오는 중' 표시
      cr = await commentsP;                     // 느린 댓글 계속 대기
      if (token !== _detailToken) return;
      showCommentsLoading(false);
    }
    await loadBlocks();   // 차단 목록 최신화(대개 목록 로드에서 캐시됨 → 즉시 반환)
    const hasBlocks = (W.__cthBlockedIds && W.__cthBlockedIds.size) || (W.__cthBlockedNicks && W.__cthBlockedNicks.size);
    // 차단이 있을 때만 모던 댓글로 숫자 author id 맵 보강 → 숫자 우선, 없으면 닉네임 폴백
    const cmap = hasBlocks ? await fetchCommentAuthorIdMap(post, req.post_seq) : null;
    if (token !== _detailToken) return;
    const rawReplys = (cr && cr.ok && cr.data && Array.isArray(cr.data.results))
      ? cr.data.results.filter(c => {
          const numId = cmap ? cmap[String(c && c.comment_seq)] : undefined;
          return !isBlocked(numId, c && c.author);
        }).map(mapReply) : [];
    applyDetail(mapDetail(post, threadReplies(rawReplys)));   // 최종 렌더(댓글 포함)
    showDetailLoading(false);                  // 이미지는 이후 <img>가 비동기 로드(표시를 막지 않음)
  }

  // 닉네임 우클릭 → 그 작성자의 글 목록. author_id를 spec에 인코딩해 스크롤 페이지네이션에도 유지된다.
  async function handleOthers(postSeq) {
    const detail = W.g_lol_current_detail || {};
    let authorId = detail.__cthAuthorId;
    if (!authorId && postSeq != null) {
      const dr = await apiFetch('detail', { post_seq: postSeq });
      if (dr && dr.ok && dr.data && dr.data.post) authorId = s(dr.data.post.author_id);
    }
    if (!authorId) { _origEmit('lol_get_article_list_others', postSeq); return; }
    // index_socket.js:665 핸들러 재현
    W.g_lol_search_body = ''; W.g_lol_search_nick = ''; W.g_lol_search_vote = false;
    W.g_lol_search_mine = true; W.g_lol_is_award = false;
    W.g_lol_article_scroll_seq = 0; W.g_lol_article_list = [];
    W.g_lol_lpanel_scroll_top_switch = true;
    W.g_lol_spec_android_id = 'cth-author:' + authorId;
    handleList({ seq: 0, cnt: 30, mine: true, android_id: 'cth-author:' + authorId });
  }

  /* ---------------- 글/댓글 쓰기 ---------------- */
  function genReqId() {
    return 'cth-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }
  function writeErr(resp) {
    if (!resp) return '응답 없음';
    if (resp.status === 401) return '로그인이 필요합니다(토큰 만료). 다시 로그인해 주세요.';
    let d = resp.data && resp.data.detail;
    if (Array.isArray(d)) d = d.map((e) => (e.loc ? e.loc.join('.') + ':' : '') + e.msg).join(', ');
    return (resp.status ? ('HTTP ' + resp.status) : (resp.error || '실패')) + (d ? (' — ' + d) : '');
  }

  async function handleWritePost(data) {
    data = data || {};
    // 사이트(index_lol.js)가 본문 끝에 붙이는 '<ㄹㅗㄹㄷㅣ>' 워터마크를 신 API로 보내기 전에 제거.
    // (구 백엔드는 응답 시 떼어냈지만 신 API는 그대로 저장·반환 → 앱에서 노출되므로 아예 저장 안 함)
    const body = stripDjMarker(s(data.body));
    if (!body) return;
    const resp = await apiFetch('writePost', {
      request_id: genReqId(), title: data.subject || '', body: body, youtube_url: data.youtube_url || '',
      image: data.image || '', is_gif: !!data.is_gif
    });
    console.log('[cth-board] writePost:', resp);
    if (resp && resp.ok) {
      ['lol_write_subject', 'lol_write_body', 'lol_write_youtube'].forEach((id) => { const e = document.getElementById(id); if (e) e.value = ''; });
      try { W.lol_write_panel_toggle(false); } catch (e) {}
      try { W.lol_onclick_aritcle_list_refresh(); } catch (e) {}
      if (data.image && resp.image_ok === false) setTimeout(() => alert('글은 등록됐지만 이미지는 첨부되지 않았습니다.\n이미지 첨부는 앱 전용 인증(서명)이 필요해 확장에서는 지원되지 않습니다. 이미지는 앱에서 올려주세요.'), 50);
    } else {
      alert('글 등록 실패: ' + writeErr(resp));
    }
  }

  async function handleWriteComment(data) {
    data = data || {};
    if (!data.body) return;
    const detail = W.g_lol_current_detail || {};
    const postSeq = data.post_seq || detail.post_seq;
    if (!postSeq) { alert('댓글 대상 글을 확인할 수 없습니다. 글을 다시 열어주세요.'); return; }
    // legacy-write 경로(레거시 post_seq 그대로) → 구 저장소 기록 → 앱에도 보임. 신 id 해석 불필요.
    // 답글 대상이 지정돼 있으면 parent_id 로 전송 → 답글로 등록.
    const parentId = cthReply.parent_id ? Number(cthReply.parent_id) : undefined;
    // 입력창엔 태그를 넣지 않으므로, 등록 시점에 '@닉네임 '을 본문 앞에 자동 삽입한다.
    let body = data.body || '';
    if (cthReply.parent_id && cthReply.nick) {
      const tag = '@' + cthReply.nick + ' ';
      if (!body.startsWith(tag)) body = tag + body;
    }
    const resp = await apiFetch('writeComment', { post_seq: postSeq, request_id: genReqId(), body: body, image: data.image || '', is_gif: !!data.is_gif, parent_id: parentId });
    console.log('[cth-board] writeComment:', resp);
    if (resp && resp.ok) {
      clearReplyTarget();
      const inp = document.getElementById('lol_rpanel_reply_board_input'); if (inp) inp.value = '';
      await handleDetail({ post_seq: postSeq });   // 구 저장소 재조회 → 새 댓글(앱과 동일) 표시
      const body = document.getElementById('lol_rpanel_body'); if (body) body.scroll(0, 99999999);
      if (data.image && resp.image_ok === false) setTimeout(() => alert('댓글은 등록됐지만 이미지는 첨부되지 않았습니다.\n이미지 첨부는 앱 전용 인증(서명)이 필요해 확장에서는 지원되지 않습니다. 이미지는 앱에서 올려주세요.'), 50);
    } else {
      alert('댓글 등록 실패: ' + writeErr(resp));
    }
  }

  /* 내 글 삭제 (사이트 lol_onclick_delete 가 confirm 후 lol_delete emit → 여기서 신 API 호출) */
  async function handleDeletePost(data) {
    const postSeq = (data && data.post_seq) || (W.g_lol_current_detail && W.g_lol_current_detail.post_seq);
    if (!postSeq) return;
    const resp = await apiFetch('deletePost', { post_seq: postSeq, request_id: genReqId() });
    console.log('[cth-board] deletePost:', resp);
    if (resp && resp.ok) {
      try { W.lol_onclick_aritcle_list_refresh(); } catch (e) {}   // 목록 새로고침(삭제된 글 제외)
      const back = document.getElementById('cth-board-back-detail'); // 컴팩트: 목록 뷰로 복귀
      if (back) back.click();
      setTimeout(() => alert('삭제 되었습니다.'), 30);
    } else {
      alert('글 삭제 실패: ' + writeErr(resp));
    }
  }

  /* 유저 차단 (사이트 '[차단하기]' 버튼 lol_rpanel_header_button 클릭 → 신 API POST /blocks)
     서버 차단 목록은 앱과 공유되므로, 여기서 차단하면 앱 차단 목록에도 반영된다. */
  async function handleBlockUser() {
    const d = W.g_lol_current_detail;
    if (!d || d.post_seq == null || s(d.post_seq).length === 0) return;
    const myKey = W.__cthLocalUserKey;
    if (!myKey) { alert('로그인이 필요합니다.'); return; }
    const nick = s(d.nickname);
    const authorId = s(d.__cthAuthorId || d.author_id);
    if (d.my_post === '1' || isMyContent(authorId)) { alert('자신은 차단할 수 없습니다.'); return; }
    if (!W.confirm((nick || '이 사용자') + ' 님을 차단하시겠습니까?\n차단한 사용자의 글과 댓글은 보이지 않습니다.')) return;
    // 차단엔 대상의 숫자 user id가 필요 → 모던 글 상세의 author.id 로 해석
    const idr = await apiFetch('authorNumId', { post_seq: d.post_seq, author_id: authorId });
    if (!idr || !idr.ok || idr.author_id == null) { alert('차단 대상 정보를 확인하지 못했습니다.'); return; }
    const resp = await apiFetch('blockUser', { local_user_key: myKey, blocked_user_id: idr.author_id, blocked: true });
    console.log('[cth-board] blockUser:', resp);
    if (resp && resp.ok) {
      // 로컬 차단 캐시 즉시 반영(재조회 없이 바로 숨김)
      W.__cthBlockedIds = W.__cthBlockedIds || new Set(); W.__cthBlockedIds.add(String(idr.author_id));
      if (nick) { W.__cthBlockedNicks = W.__cthBlockedNicks || new Set(); W.__cthBlockedNicks.add(nick.trim()); }
      try { W.lol_onclick_aritcle_list_refresh(); } catch (e) {}   // 목록 새로고침(차단 글 제외)
      const back = document.getElementById('cth-board-back-detail'); // 컴팩트: 목록 뷰로 복귀
      if (back) back.click();
      setTimeout(() => alert((nick || '사용자') + ' 님을 차단했습니다.'), 30);
    } else {
      alert('차단 실패: ' + writeErr(resp));
    }
  }
  // 사이트가 index.js 에서 lol_rpanel_header_button.onclick = lol_onclick_auth_or_block(원본참조)로 바인딩.
  // 그 버튼의 onclick 을 교체해, 신모드+로그인 상태면 차단을 수행하고, 그 외(게스트=로그인요청)엔 원본 호출.
  function ensureBlockButtonBound() {
    const btn = document.getElementById('lol_rpanel_header_button');
    if (!btn || btn.__cthBlockBound) return;
    btn.__cthBlockBound = true;
    btn.onclick = function (e) {
      if (document.documentElement.dataset.cthNewBoard !== '0'
          && W.g_lol_android_id && W.g_lol_android_id !== W.g_lol_guest_id) {
        if (e && e.preventDefault) e.preventDefault();
        handleBlockUser();
        return;
      }
      if (typeof W.lol_onclick_auth_or_block === 'function') return W.lol_onclick_auth_or_block.call(this, e);
    };
  }

  /* 내 댓글 삭제 (사이트 lol_onclick_delete_reply → lol_delete_reply emit) */
  async function handleDeleteComment(data) {
    const postSeq = data && data.post_seq;
    const replySeq = data && data.reply_seq;
    if (!postSeq || !replySeq) return;
    const resp = await apiFetch('deleteComment', { post_seq: postSeq, comment_seq: replySeq, request_id: genReqId() });
    console.log('[cth-board] deleteComment:', resp);
    if (resp && resp.ok) {
      await handleDetail({ post_seq: postSeq });   // 갱신된 댓글 목록 재조회·표시
    } else {
      alert('댓글 삭제 실패: ' + writeErr(resp));
    }
  }

  function cthLogout() {
    apiFetch('logout', {});
    W.g_lol_android_id = GUEST_ID;
    W.g_lol_user_info = null;
    W.__cthLocalUserKey = '';
    W.__cthMyIds = [];
    const wb = document.getElementById('lol_lpanel_write_button'); if (wb) wb.style.display = 'none';
    try { W.lol_lpanel_update(); } catch (e) {}
    try { W.lol_rpanel_update(); } catch (e) {}
    log('로그아웃 처리 완료');
  }

  /* ---------------- 로그인 (계정코드 → ID/PW) ---------------- */
  const GUEST_ID = 'LoLWikiDJ_Guest';
  function isGuest() {
    const id = W.g_lol_android_id;
    return !id || id === GUEST_ID || (typeof W.g_lol_guest_id !== 'undefined' && id === W.g_lol_guest_id);
  }

  // 신 유저정보를 사이트 g_lol_user_info 형태로 매핑하고 로그인 상태로 전환
  function applyLoggedIn(user, accountId) {
    user = user || {};
    const nickname = user.nickname || user.name || accountId || '';
    const stack = (user.stack_count != null) ? user.stack_count : ((user.point != null) ? user.point : (user.stack || 0));
    const avatar = user.avatar_url || user.avatar || user.icon_url || '';
    const uid = user.account_id || user.id || accountId || nickname || 'cth_user';
    W.g_lol_android_id = String(uid);
    W.__cthLocalUserKey = user.local_user_key || user.localUserKey || '';  // 쪽지 등 local_user_key 용도
    W.__cthUserId = user.id || user.user_id || null;                        // 알림센터 채팅 좌/우 구분용
    // 내 소유 판별용 식별자 모음 (author_id 는 legacy 계정이면 legacy_id 형식)
    W.__cthMyIds = [user.local_user_key, user.legacy_id, user.legacy_android_id, user.legacy_device_id]
      .filter(function (x) { return x; }).map(String);
    W.g_lol_user_info = {
      nickname: nickname, point: stack, iconpic: '', badge_use: '',
      android_id: String(uid), __cthAvatar: avatar
    };
    const wb = document.getElementById('lol_lpanel_write_button'); if (wb) wb.style.display = 'block';
    try { W.lol_lpanel_update(); } catch (e) {}
    try { W.lol_rpanel_update(); } catch (e) {}
    if (avatar) setImg(document.getElementById('lol_lpanel_account_icon'), avatar);
    W.__cthBlockedIds = new Set(); W.__cthBlockedNicks = new Set(); _blocksAt = 0;   // 계정 전환 시 캐시 폐기
    loadBlocks(true).catch(function () {});            // 새 계정의 차단 목록 선반영
    log('로그인 상태 적용:', nickname);
  }

  function closeLoginModal() {
    const m = document.getElementById('cth-login-modal'); if (m) m.remove();
  }
  function showLoginModal() {
    if (document.getElementById('cth-login-modal')) return;
    if (!document.getElementById('cth-login-style')) {
      const st = document.createElement('style'); st.id = 'cth-login-style';
      st.textContent = `
        #cth-login-modal{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:'Segoe UI',sans-serif}
        #cth-login-box{width:300px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:10px;padding:18px 18px 14px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
        #cth-login-box h4{margin:0 0 4px;font-size:15px;color:#fff}
        #cth-login-box .cth-sub{font-size:11px;color:#888;margin-bottom:12px}
        #cth-login-box input{width:100%;box-sizing:border-box;margin:5px 0;padding:9px 10px;background:#2a2a2a;border:1px solid #444;border-radius:6px;color:#eee;font-size:13px}
        #cth-login-box input:focus{outline:none;border-color:#339af0}
        #cth-login-box .cth-row{display:flex;gap:8px;margin-top:10px}
        #cth-login-box button{flex:1;padding:9px 0;border:none;border-radius:6px;font-size:13px;cursor:pointer}
        #cth-login-do{background:#1c7ed6;color:#fff}
        #cth-login-cancel{background:#333;color:#ccc}
        #cth-login-status{font-size:12px;color:#e03131;min-height:16px;margin-top:8px}
      `;
      document.head.appendChild(st);
    }
    const ov = document.createElement('div'); ov.id = 'cth-login-modal';
    ov.innerHTML = `
      <div id="cth-login-box">
        <h4>자유게시판 로그인</h4>
        <div class="cth-sub">롤백과사전 계정 (ID / 비밀번호)</div>
        <input id="cth-login-id" type="text" placeholder="아이디" autocomplete="username">
        <input id="cth-login-pw" type="password" placeholder="비밀번호" autocomplete="current-password">
        <div id="cth-login-status"></div>
        <div class="cth-row">
          <button id="cth-login-do">로그인</button>
          <button id="cth-login-cancel">취소</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const idEl = ov.querySelector('#cth-login-id');
    const pwEl = ov.querySelector('#cth-login-pw');
    const statusEl = ov.querySelector('#cth-login-status');
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeLoginModal(); });
    ov.querySelector('#cth-login-cancel').onclick = closeLoginModal;
    const submit = () => doLogin(idEl.value.trim(), pwEl.value, statusEl);
    ov.querySelector('#cth-login-do').onclick = submit;
    pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    idEl.focus();
  }

  async function doLogin(accountId, password, statusEl) {
    if (!accountId || !password) { statusEl.textContent = '아이디와 비밀번호를 입력하세요.'; return; }
    statusEl.style.color = '#888'; statusEl.textContent = '로그인 중...';
    const resp = await apiFetch('login', { account_id: accountId, password: password });
    console.log('[cth-board] login response:', resp);   // 응답 형태 확인용(테스트)
    if (resp && resp.ok) {
      const user = (resp.auth && resp.auth.user) || (resp.data && (resp.data.user || (resp.data.data && resp.data.data.user))) || null;
      applyLoggedIn(user, accountId);
      closeLoginModal();
    } else {
      statusEl.style.color = '#e03131';
      const why = resp && (resp.status ? ('HTTP ' + resp.status) : resp.error) || '실패';
      statusEl.textContent = '로그인 실패: ' + why + ' (콘솔 확인)';
    }
  }

  function installAuth() {
    // 로그인 진입점 가로채기: 사이트가 '계정 코드' prompt를 띄우는 순간을 낚아채 ID/PW 모달로 대체.
    // (onclick 바인딩 타이밍/재할당에 영향받지 않도록 window.prompt를 후킹)
    if (!W.__cthPromptHooked) {
      W.__cthPromptHooked = true;
      const origPrompt = (typeof W.prompt === 'function') ? W.prompt.bind(W) : null;
      W.prompt = function (message, def) {
        if (document.documentElement.dataset.cthNewBoard !== '0' && isGuest()
            && typeof message === 'string' && message.indexOf('계정 코드') !== -1) {
          setTimeout(showLoginModal, 0);
          return null; // 원래 계정코드 로그인 흐름은 취소하고 내 모달로 대체
        }
        return origPrompt ? origPrompt(message, def) : null;
      };
      log('로그인(계정코드→ID/PW) 후킹 설치됨');
    }
    // 로그아웃: 사이트가 g_lol_android_id를 리셋하지 않아, confirm('...로그아웃...') 승인 시
    // 저장 인증 삭제 + 게스트 상태로 리셋해야 실제로 로그아웃됨.
    if (!W.__cthConfirmHooked) {
      W.__cthConfirmHooked = true;
      const origConfirm = (typeof W.confirm === 'function') ? W.confirm.bind(W) : null;
      W.confirm = function (message) {
        const r = origConfirm ? origConfirm(message) : true;
        if (r && typeof message === 'string' && message.indexOf('로그아웃') !== -1) setTimeout(cthLogout, 0);
        return r;
      };
    }
    // 페이지 로드 시 저장된 로그인 복원
    if (!W.__cthAuthRestored) {
      W.__cthAuthRestored = true;
      apiFetch('authState', {}).then((resp) => {
        if (resp && resp.ok && resp.auth && (resp.auth.user || resp.auth.token) && isGuest()) {
          if (document.documentElement.dataset.cthNewBoard !== '0') applyLoggedIn(resp.auth.user, resp.auth.account_id);
        }
      });
    }
  }

  /* ---------------- 설치: 렌더 함수 래핑 + socket.emit 인터셉트 ---------------- */
  function wrapRenderFns() {
    if (typeof W.lol_lpanel_update === 'function' && !W.lol_lpanel_update.__cthWrapped) {
      const orig = W.lol_lpanel_update;
      W.lol_lpanel_update = function () { const r = orig.apply(this, arguments); try { fixupList(); } catch (e) {} return r; };
      W.lol_lpanel_update.__cthWrapped = true;
    }
    if (typeof W.lol_rpanel_update === 'function' && !W.lol_rpanel_update.__cthWrapped) {
      const orig = W.lol_rpanel_update;
      W.lol_rpanel_update = function () {
        // 렌더가 리스트 자식을 removeChild로 비우므로, 입력창이 리스트 안에 있으면 분리되어 깨진다.
        // 렌더 전에 항상 맨 아래(원위치)로 빼두고, 렌더 후 decorateAllReplies에서 대상 아래로 재이동.
        try { restoreWriteToBottom(); } catch (e) {}
        const r = orig.apply(this, arguments);
        try { fixupDetail(); } catch (e) {}
        try { decorateAllReplies(); } catch (e) {}
        try { ensureBlockButtonBound(); } catch (e) {}   // '[차단하기]' 버튼에 신 API 차단 연결
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
      // 팝업 '설정'의 체크박스로 켜고 끔 (relay가 dataset.cthNewBoard 세팅, 기본 ON)
      const enabled = document.documentElement.dataset.cthNewBoard !== '0';
      // 채팅으로 공유되는 img.lolwiki.kr 이미지는 Referer 핫링크 보호로 'BG.GG 안내' 이미지가 뜬다.
      // 공유 메시지의 URL을 DJ 서버 미러(서버측에서 Referer 없이 대신 받아옴)로 치환하면,
      // 메시지 자체에 미러 URL이 담겨 확장 없는 사람 포함 모두가 원본 이미지를 본다.
      if (enabled && event === 'chat_message' && args[0] && typeof args[0].message === 'string'
          && args[0].message.indexOf('img.lolwiki.kr') !== -1) {
        args[0].message = args[0].message.replace(/https?:\/\/img\.lolwiki\.kr\/\S+/g,
          function (u) { return W.location.origin + '/lolwiki_mirror/i?uri=' + encodeURIComponent(u); });
      }
      if (enabled && event === 'lol_get_article_list') { handleList(args[0]); return sock; }
      if (enabled && event === 'lol_get_article_list_others') { handleOthers(args[0]); return sock; }
      if (enabled && event === 'lol_get_article_detail') { handleDetail(args[0]); return sock; }
      if (enabled && event === 'lol_write') { handleWritePost(args[0]); return sock; }
      if (enabled && event === 'lol_write_reply') { handleWriteComment(args[0]); return sock; }
      if (enabled && event === 'lol_delete') { handleDeletePost(args[0]); return sock; }
      if (enabled && event === 'lol_delete_reply') { handleDeleteComment(args[0]); return sock; }
      return _origEmit(event, ...args);
    };
    wrapped.__cthWrapped = true;
    sock.emit = wrapped;
    log('socket.emit 인터셉트 설치됨');
    return true;
  }

  /* ---------------- 알림센터 (신버전: 알림 탭 + 채팅=쪽지 탭) ---------------- */
  const cthN = { open: false, tab: 'notif', thread: null };
  function nEsc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function nRel(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(iso || '')); if (!m) return '';
    const ep = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') + '+09:00');
    const sec = Math.floor((Date.now() - ep) / 1000), min = Math.floor(sec / 60);
    if (sec < 60) return Math.max(0, sec) + '초전';
    if (min < 60) return min + '분전';
    const nk = new Date(Date.now() + 9 * 3600 * 1000);
    if (nk.getUTCFullYear() == +m[1] && nk.getUTCMonth() + 1 == +m[2] && nk.getUTCDate() == +m[3]) return m[4] + ':' + m[5];
    return m[1] + '-' + m[2] + '-' + m[3];
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
    if (document.documentElement.dataset.cthNewBoard === '0') return; // 신버전 모드에서만
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
      if (document.documentElement.dataset.cthNewBoard === '0') return;
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
    handleDetail({ post_seq: postSeq });
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
    if (document.documentElement.dataset.cthNewBoard === '0' || !myKey()) return;
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

  // socket / 렌더 함수가 준비될 때까지 대기 후 설치
  let tries = 0;
  const timer = setInterval(() => {
    wrapRenderFns();
    try { installAuth(); } catch (e) {}
    try { installNotificationCenter(); } catch (e) {}
    const done = wrapSocket();
    if ((done && W.lol_lpanel_update && W.lol_lpanel_update.__cthWrapped) || ++tries > 100) {
      clearInterval(timer);
    }
  }, 200);
})();
