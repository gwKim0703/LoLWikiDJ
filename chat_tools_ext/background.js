/* background.js — 자유게시판 신 API 중계 */

/* ============================================================
 * 자유게시판 신 API 중계 (앱 v2.0.3 이후)
 * 구 lolwiki.kr PHP 엔드포인트가 2026-07-19 04:00:23에 동결되어,
 * 신 REST API(https://lolwiki.kr/api/app/api/v1)에서 목록/글/댓글을 읽어온다.
 * 읽기는 인증 불필요. background에서 fetch하여 CORS를 우회한다.
 * (자세한 API 규격은 API_NOTES.md 참고)
 * ============================================================ */
/* 참고: 이미지 첨부(img.lolwiki.kr 업로드)는 앱이 SecurityGuard(libEncryptorP/Wua)로 매 요청
   동적 생성하는 서명을 요구한다(기기 비밀키 기반·요청마다 상이). 브라우저 확장(JS)에서는
   이 서명을 재현할 수 없어 이미지 업로드는 지원 불가. (텍스트/유튜브 작성은 서명 불필요라 동작)
   아래 uploadImage 코드는 남겨두지만, 실제로는 img 호스트가 항상 "로그인 필요"로 거부한다. */

const LOLAPI_BASE = 'https://lolwiki.kr/api/app/api/v1';
const LOLAPI_HEADERS = {
  'X-App-Platform': 'android',
  'X-App-Version': '2.0.3',
  'X-App-Build': '1784442393',   // 앱 versionCode (앱과 동일한 클라이언트로 인식되게)
  'Accept': 'application/json'
};
const enc = encodeURIComponent;

function getAuth() {
  return new Promise((r) => chrome.storage.local.get('cthLolAuth', (d) => r(d.cthLolAuth || null)));
}
function setAuth(a) {
  return new Promise((r) => chrome.storage.local.set({ cthLolAuth: a }, r));
}

// access_token 만료(1800s) 시 refresh_token으로 갱신
async function refreshToken() {
  const auth = await getAuth();
  if (!auth || !auth.refresh) return null;
  const r = await fetch(`${LOLAPI_BASE}/auth/refresh`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, LOLAPI_HEADERS),
    body: JSON.stringify({ refresh_token: auth.refresh })
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  const a = (j && j.auth) || j || {};
  const token = a.access_token || a.accessToken;
  if (!token) return null;
  auth.token = token;
  if (a.refresh_token || a.refreshToken) auth.refresh = a.refresh_token || a.refreshToken;
  await setAuth(auth);
  return auth;
}

// Authorization: Bearer 자동 첨부 + 401시 1회 refresh 재시도
async function authedFetch(url, opts, extraHeaders) {
  let auth = await getAuth();
  // 앱과 동일하게 X-Device-ID(로그인 device_id) + Bearer 첨부
  const build = (a) => Object.assign({}, LOLAPI_HEADERS, extraHeaders || {},
    (a && a.device_id) ? { 'X-Device-ID': a.device_id } : {},
    (a && a.token) ? { 'Authorization': 'Bearer ' + a.token } : {});
  let r = await fetch(url, Object.assign({}, opts, { headers: build(auth) }));
  if (r.status === 401 && auth && auth.refresh) {
    const na = await refreshToken();
    if (na) r = await fetch(url, Object.assign({}, opts, { headers: build(na) }));
  }
  return r;
}
function respond(sendResponse, promise) {
  promise
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))
    .then(({ status, data }) => sendResponse({ ok: status >= 200 && status < 300, status, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
}

// 이미지 업로드(멀티파트) → { ok, image_id, image_format, image_url }
// 앱 v2.0.3 libapp.so 분석 기준: POST https://img.lolwiki.kr/api/images, 멀티파트 필드 'file',
// Bearer 인증 필요, 응답 봉투 {success, message, data:{...}}. 응답 키는 방어적으로 파싱한다.
async function uploadImage(imageData, isGif) {
  if (!imageData) return { ok: false, error: 'no image' };
  const auth = await getAuth();
  if (!auth || !auth.token) return { ok: false, error: '로그인이 필요합니다(이미지 업로드).' };
  let b64 = imageData, mime = isGif ? 'image/gif' : 'image/jpeg';
  const m = /^data:([^;]+);base64,(.*)$/i.exec(imageData);
  if (m) { mime = m[1]; b64 = m[2]; }
  let bytes;
  try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
  catch (e) { return { ok: false, error: 'invalid image data' }; }
  const blob = new Blob([bytes], { type: mime });
  const fmt = isGif ? 'gif' : (mime.indexOf('png') >= 0 ? 'png' : 'jpg');
  // 앱과 동일하게 Bearer + X-Device-ID 를 함께 보낸다 (img.lolwiki.kr도 이 조합을 검증).
  const buildHeaders = (a) => Object.assign({}, LOLAPI_HEADERS,
    (a && a.device_id) ? { 'X-Device-ID': a.device_id } : {},
    { 'Authorization': 'Bearer ' + a.token });

  // 필드명 순차 시도. 성공 → {ok,...}, 인증실패 → {authFail:true, ...}, 그 외 → 마지막 진단객체
  async function tryUpload(a) {
    let last = null;
    for (const field of ['file', 'files', 'image', 'images']) {
      let r, j;
      try {
        const fd = new FormData();
        fd.append(field, blob, 'image.' + fmt);
        r = await fetch('https://img.lolwiki.kr/api/images', { method: 'POST', headers: buildHeaders(a), body: fd });
        j = await r.json().catch(() => null);
      } catch (e) { last = { error: String((e && e.message) || e) }; continue; }
      console.log('[cth-bg] uploadImage field=' + field, r.status, j);
      if (j && j.success === false && typeof j.message === 'string' && j.message.indexOf('로그인') !== -1) {
        return { authFail: true, status: r.status, data: j };   // 필드 바꿔도 소용없음
      }
      last = { status: r.status, data: j };
      if (r.ok && j && j.success !== false) {
        const d = j.data || j;
        const image_id = d.image_id || d.id || (d.image && (d.image.id || d.image.image_id));
        const image_url = d.image_url || d.url || d.original_url || d.imageUrl || (d.image && d.image.url) || '';
        const resFmt = d.image_format || d.format || fmt;
        if (image_id != null && String(image_id) !== '') {
          return { ok: true, image_id: String(image_id), image_format: String(resFmt), image_url: image_url };
        }
      }
    }
    return last || {};
  }

  let res = await tryUpload(auth);
  if (res && res.authFail && auth.refresh) {          // 토큰 만료로 보이면 refresh 후 1회 재시도
    const na = await refreshToken();
    if (na) { auth = na; res = await tryUpload(na); }
  }
  if (res && res.ok) return res;
  if (res && res.authFail) return { ok: false, error: '로그인이 필요합니다(토큰 만료/불일치). 다시 로그인해 주세요.' };
  const msg = res && res.data && (res.data.message || (res.data.detail && JSON.stringify(res.data.detail)));
  return { ok: false, error: 'image upload failed' + (msg ? (' — ' + msg) : '') };
}
async function registerPending(image_id, image_format) {
  const r = await authedFetch(`${LOLAPI_BASE}/board/legacy-write/images/pending`, {
    method: 'POST', body: JSON.stringify({ image_id: image_id, image_format: image_format })
  }, { 'Content-Type': 'application/json' }).catch(() => null);
  console.log('[cth-bg] registerPending', image_id, r && r.status);
  return !!(r && r.ok);
}

// 구 post_seq → 신 post id 해석
// (1) 이전 이후 글: id = post_seq - offset (offset은 신 board 최신글에서 동적 도출) — GET으로 검증
// (2) 이전 이전 글(레거시 작성자): legacy-identity(author_id)로 매핑
let _seqOffset = null;
async function getSeqOffset() {
  if (_seqOffset != null) return _seqOffset;
  const r = await fetch(`${LOLAPI_BASE}/board/posts?limit=1`, { headers: LOLAPI_HEADERS }).catch(() => null);
  const j = r && await r.json().catch(() => null);
  const it = j && j.results && j.results[0];
  if (it && it.id != null && it.legacy_post_seq != null) _seqOffset = it.legacy_post_seq - it.id;
  return _seqOffset;
}
async function resolveNewId(post_seq, author_id) {
  const off = await getSeqOffset();
  if (off != null) {
    const guess = Number(post_seq) - off;
    if (guess > 0) {
      const r = await fetch(`${LOLAPI_BASE}/board/posts/${enc(guess)}`, { headers: LOLAPI_HEADERS }).catch(() => null);
      const j = r && r.ok && await r.json().catch(() => null);
      const pp = j && j.post;
      if (pp && String(pp.legacy_post_seq) === String(post_seq)) return guess;   // 검증 통과
    }
  }
  if (author_id && String(author_id).indexOf('lolwiki-') !== 0) {   // 레거시 작성자만 legacy-identity 유효
    const r = await fetch(`${LOLAPI_BASE}/users/legacy-identity?legacy_id=${enc(author_id)}`, { headers: LOLAPI_HEADERS }).catch(() => null);
    const j = r && await r.json().catch(() => null);
    const m = ((j && j.posts) || []).find((x) => String(x.legacy_post_seq) === String(post_seq));
    if (m && m.id != null) return m.id;
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'cth-lolapi') return; // 다른 리스너가 처리
  const p = msg.params || {};

  // ── 저장된 로그인 상태 조회 / 로그아웃 ──
  if (msg.kind === 'authState') {
    getAuth().then((auth) => sendResponse({ ok: true, auth }));
    return true;
  }
  if (msg.kind === 'logout') {
    chrome.storage.local.remove('cthLolAuth', () => sendResponse({ ok: true }));
    return true;
  }

  // ── 로그인 (ID/PW) → 토큰/유저 저장 ──
  if (msg.kind === 'login') {
    fetch(`${LOLAPI_BASE}/users/login`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, LOLAPI_HEADERS),
      body: JSON.stringify({ account_id: p.account_id, password: p.password })
    })
      .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))
      .then(async ({ status, data }) => {
        if (status >= 200 && status < 300 && data && (data.auth || data.user)) {
          const a = data.auth || {};
          const user = data.user || null;
          const auth = {
            token: a.access_token || a.accessToken || '',
            refresh: a.refresh_token || a.refreshToken || '',
            token_type: a.token_type || 'Bearer',
            device_id: a.device_id || '',
            local_user_key: (user && user.local_user_key) || '',
            user: user,
            account_id: p.account_id,
            savedAt: Date.now()
          };
          await setAuth(auth);
          sendResponse({ ok: true, status, data, auth });
        } else {
          sendResponse({ ok: false, status, data });
        }
      })
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 구 post_seq → 신 id 해석 (offset 검증 + legacy-identity) ──
  if (msg.kind === 'resolveId') {
    resolveNewId(p.post_seq, p.author_id)
      .then((id) => sendResponse({ ok: id != null, id: id }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 글쓰기 (Bearer, 이미지 있으면 업로드 후 image_id 첨부) ──
  if (msg.kind === 'writePost') {
    (async () => {
      let image_id = '', image_format = '';
      if (p.image) {
        const up = await uploadImage(p.image, p.is_gif);
        if (up.ok) { image_id = up.image_id; image_format = up.image_format; await registerPending(image_id, image_format); }
        else console.log('[cth-bg] writePost image upload failed:', up.error);
      }
      const body = { request_id: p.request_id, title: p.title || '', body: p.body || '', youtube_url: p.youtube_url || '' };
      // LegacyPostCreate(OpenAPI): 업로드 이미지를 image_id + image_format 로 첨부. (additionalProperties 금지)
      if (image_id) { body.image_id = image_id; body.image_format = image_format; }
      const r = await authedFetch(`${LOLAPI_BASE}/board/legacy-write/posts`, { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' });
      const data = await r.json().catch(() => null);
      sendResponse({ ok: r.status >= 200 && r.status < 300, status: r.status, data, image_ok: !p.image || !!image_id });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 댓글쓰기 (legacy-write: 구 저장소에 기록 → 앱에도 보임. Bearer 인증, 레거시 post_seq 사용) ──
  if (msg.kind === 'writeComment') {
    (async () => {
      let image_id = '', image_format = '';
      if (p.image) {
        const up = await uploadImage(p.image, p.is_gif);
        if (up.ok) { image_id = up.image_id; image_format = up.image_format; await registerPending(image_id, image_format); }
        else console.log('[cth-bg] writeComment image upload failed:', up.error);
      }
      // LegacyCommentCreate(OpenAPI): image_id + image_format 로 첨부. (additionalProperties 금지)
      const body = Object.assign({ request_id: p.request_id, body: p.body || '' },
        p.parent_id ? { parent_id: p.parent_id } : {},
        image_id ? { image_id: image_id, image_format: image_format } : {});
      const r = await authedFetch(`${LOLAPI_BASE}/board/legacy-write/posts/${enc(p.post_seq)}/comments`,
        { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' });
      const data = await r.json().catch(() => null);
      console.log('[cth-bg] writeComment', r.status, data);
      sendResponse({ ok: r.status >= 200 && r.status < 300, status: r.status, data, image_ok: !p.image || !!image_id });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 내 글 삭제 (Bearer 인증, 소유자만. body: request_id) ──
  if (msg.kind === 'deletePost') {
    (async () => {
      const r = await authedFetch(`${LOLAPI_BASE}/board/legacy-write/posts/${enc(p.post_seq)}/delete`,
        { method: 'POST', body: JSON.stringify({ request_id: p.request_id }) }, { 'Content-Type': 'application/json' });
      const data = await r.json().catch(() => null);
      console.log('[cth-bg] deletePost', r.status, data);
      sendResponse({ ok: r.status >= 200 && r.status < 300, status: r.status, data });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 내 댓글 삭제 (Bearer 인증, 소유자만. body: request_id) ──
  if (msg.kind === 'deleteComment') {
    (async () => {
      const r = await authedFetch(`${LOLAPI_BASE}/board/legacy-write/posts/${enc(p.post_seq)}/comments/${enc(p.comment_seq)}/delete`,
        { method: 'POST', body: JSON.stringify({ request_id: p.request_id }) }, { 'Content-Type': 'application/json' });
      const data = await r.json().catch(() => null);
      console.log('[cth-bg] deleteComment', r.status, data);
      sendResponse({ ok: r.status >= 200 && r.status < 300, status: r.status, data });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 알림센터: 알림(푸시) 목록/읽음 ──
  if (msg.kind === 'notifs') {
    respond(sendResponse, authedFetch(`${LOLAPI_BASE}/push/notifications`, {}));
    return true;
  }
  if (msg.kind === 'notifRead') {
    const body = {};
    if (p.local_user_key) body.local_user_key = p.local_user_key;
    if (p.notification_id != null) body.notification_id = p.notification_id;
    respond(sendResponse, authedFetch(`${LOLAPI_BASE}/push/notifications/read`,
      { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' }));
    return true;
  }

  // ── 알림센터: 채팅(쪽지) 스레드/메시지 ──
  if (msg.kind === 'memoThreads') {
    respond(sendResponse, authedFetch(`${LOLAPI_BASE}/memos?local_user_key=${enc(p.local_user_key || '')}`, {}));
    return true;
  }
  if (msg.kind === 'memoThread') {
    respond(sendResponse, authedFetch(`${LOLAPI_BASE}/memos/${enc(p.thread_id)}?local_user_key=${enc(p.local_user_key || '')}`, {}));
    return true;
  }
  if (msg.kind === 'memoSend') {
    const body = { sender_local_user_key: p.local_user_key, sender_nickname: p.nickname || '', body: p.body || '' };
    respond(sendResponse, authedFetch(`${LOLAPI_BASE}/memos/${enc(p.thread_id)}/messages`,
      { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' }));
    return true;
  }
  if (msg.kind === 'memoNew') {
    const body = { sender_local_user_key: p.local_user_key, sender_nickname: p.nickname || '', body: p.body || '' };
    if (p.recipient_user_id) body.recipient_user_id = p.recipient_user_id;
    else if (p.recipient_local_user_key) body.recipient_local_user_key = p.recipient_local_user_key;
    respond(sendResponse, authedFetch(`${LOLAPI_BASE}/memos`,
      { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' }));
    return true;
  }

  // ── 읽기 (GET) — detail/comments 는 인증(Bearer) 첨부해 서버 is_mine(내 글/댓글) 을 받는다 ──
  let url;
  if (msg.kind === 'list') {
    url = `${LOLAPI_BASE}/legacy-read-compat/posts?board=freeboard`
        + `&limit=${enc(p.limit != null ? p.limit : 30)}`
        + `&offset=${enc(p.offset != null ? p.offset : 0)}`;
    if (p.q) url += `&q=${enc(p.q)}`;                    // 키워드 검색
    if (p.nickname) url += `&nickname=${enc(p.nickname)}`; // 닉네임 검색 / 내 글
    if (p.author_id) url += `&author_id=${enc(p.author_id)}`; // 작성자별 글
    if (p.mode) url += `&mode=${enc(p.mode)}`;            // mode=popular → 인기글(추천순)
  } else if (msg.kind === 'detail') {
    url = `${LOLAPI_BASE}/legacy-read-compat/post?post_seq=${enc(p.post_seq)}`;
  } else if (msg.kind === 'comments') {
    url = `${LOLAPI_BASE}/legacy-read-compat/comments?post_seq=${enc(p.post_seq)}`;
  } else if (msg.kind === 'commentsById') {
    // 신 댓글 저장소(작성 댓글 포함 전체) — 구 post_seq를 신 id로 해석해 사용
    url = `${LOLAPI_BASE}/board/posts/${enc(p.id)}/comments`;
  } else {
    sendResponse({ ok: false, error: 'unknown kind: ' + msg.kind });
    return true;
  }

  const readReq = (msg.kind === 'detail' || msg.kind === 'comments')
    ? authedFetch(url, {})                       // 로그인 시 is_mine 을 받기 위해 Bearer 첨부
    : fetch(url, { headers: LOLAPI_HEADERS });
  readReq
    .then(r => r.json())
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async sendResponse
});
