/* background.js — 신 API 중계 (확장 보조 기능 전용)
 *
 * 자유게시판 데이터(목록·글·댓글·작성·삭제·차단·이미지 첨부)는 DJ 사이트가 신 REST API로
 * 직접 처리한다. 확장이 중계하는 것은 사이트가 아직 제공하지 않는 기능뿐이다.
 *   login/logout/authState : 사이트 로그인 자격증명으로 확장도 토큰 확보(별도 로그인 없음)
 *   profile                : 내 프로필 최신값(GET /users/me) — 좌측 상단 아이콘 즉시 갱신
 *   vote / detail          : 추천·비추천(토글)과 '내 추천 상태' 조회
 *   notifs/notifRead/memo* : 알림센터(알림·쪽지)
 * 호출은 CORS 우회를 위해 background에서 수행한다. (API 규격은 API_NOTES.md 참고)
 */

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

/* ---------------- 이미지 업로드 (답글 첨부용) ----------------
   DJ 사이트 서버(lolwiki-api.js uploadImage)와 동일한 방식이다.
     · multipart 필드: password('lolwiki-app-marker') + image(파일)
     · Authorization 헤더는 붙이지 않는다 — 붙이면 '등록 된 앱이 아닙니다'로 거부된다.
   업로드로 받은 image_id 를 pending 등록한 뒤 댓글 작성 본문에 넣는다. */
const IMAGE_UPLOAD_URL = 'https://img.lolwiki.kr/api/images';
const IMAGE_UPLOAD_PASSWORD = 'lolwiki-app-marker';

/* img 서버는 Origin 헤더가 붙은 요청을 '등록 된 앱이 아닙니다'로 거부한다.
   (앱·DJ 서버는 Origin 없이 보내므로 통과 / 허용되는 Origin 은 https://lolwiki.kr 뿐)
   확장 fetch 는 Origin: chrome-extension://... 을 자동으로 붙이므로 제거할 수 없다.
   → 업로드 요청에 한해 declarativeNetRequest 로 Origin 을 허용값으로 바꿔 보낸다. */
const DNR_ORIGIN_RULE_ID = 1701;
let _dnrReady = null;
function ensureUploadOriginRule() {
  if (_dnrReady) return _dnrReady;
  _dnrReady = (async () => {
    try {
      if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return false;
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [DNR_ORIGIN_RULE_ID],
        addRules: [{
          id: DNR_ORIGIN_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'origin', operation: 'set', value: 'https://lolwiki.kr' }]
          },
          condition: { urlFilter: '||img.lolwiki.kr/api/images', resourceTypes: ['xmlhttprequest'] }
        }]
      });
      console.log('[cth-bg] 업로드 Origin 규칙 등록됨');
      return true;
    } catch (e) {
      console.log('[cth-bg] 업로드 Origin 규칙 등록 실패:', e);
      return false;
    }
  })();
  return _dnrReady;
}
function b64ToBytes(b64) {
  // data: 접두 제거 → 공백/개행 제거 → URL-safe 문자 복원 → 패딩 보정(전송 중 변형 대비)
  let str = String(b64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
    .replace(/-/g, '+').replace(/_/g, '/');
  const rem = str.length % 4;
  if (rem === 2) str += '==';
  else if (rem === 3) str += '=';
  else if (rem === 1) str = str.slice(0, -1);        // 손상된 마지막 1글자는 버린다
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// format: 'gif' | 'webp' | 'jpg'(기본). GIF·WebP 는 캔버스 변환 시 애니메이션이 사라지므로
// 원본 바이트를 그대로 올리고 형식도 그대로 알린다.
const IMAGE_MIME = { gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg' };
async function uploadImage(imageData, format) {
  if (!imageData) return { ok: false, error: 'no image' };
  const fmt = IMAGE_MIME[format] ? format : 'jpg';
  let bytes;
  try {
    bytes = b64ToBytes(imageData);
  } catch (e) {
    return { ok: false, error: 'base64 디코딩 실패(len=' + String(imageData).length + '): ' + ((e && e.message) || e) };
  }
  if (!bytes.length) return { ok: false, error: 'empty image' };
  const originOk = await ensureUploadOriginRule();     // Origin 치환 규칙 준비(없으면 서버가 거부)
  const auth = await getAuth();
  const fd = new FormData();
  fd.append('password', IMAGE_UPLOAD_PASSWORD);
  fd.append('image', new Blob([bytes], { type: IMAGE_MIME[fmt] }),
    'lolwikidj-' + Date.now().toString(36) + '.' + fmt);
  const headers = Object.assign({}, LOLAPI_HEADERS);          // Authorization 없음(의도적)
  if (auth && auth.device_id) headers['X-Device-ID'] = auth.device_id;
  let r, netErr = '';
  try {
    r = await fetch(IMAGE_UPLOAD_URL, { method: 'POST', headers, body: fd });
  } catch (e) { netErr = 'fetch 실패: ' + ((e && e.message) || e); }
  const j = r && await r.json().catch(() => null);
  const id = j && ((j.data && j.data.id) || j.image_id || j.id);
  console.log('[cth-bg] uploadImage bytes=' + bytes.length, 'originRule=' + originOk, r && r.status,
    id || netErr || (j && j.message));
  if (r && r.ok && id) return { ok: true, image_id: String(id), image_format: fmt };
  let why = netErr || (j && (j.message || j.detail)) || ('HTTP ' + (r ? r.status : '?'));
  if (!originOk && /등록/.test(String(why))) why += ' (Origin 치환 규칙 미적용 — 확장을 새로고침해 주세요)';
  return { ok: false, error: why };
}
/* ---------------- 구 post_seq → 신 post id 해석 (차단 대상의 숫자 user id 확보용) ----------------
   신 게시글 id 는 구 post_seq 에서 일정한 offset 을 뺀 값이라, 최신 글에서 offset 을 구해 추정한 뒤
   실제로 조회해 legacy_post_seq 가 일치하는지 검증한다. 실패 시 레거시 작성자는 legacy-identity 로 매핑. */
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
      const pp = j && (j.post || j.data || j);
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

async function registerPending(image_id, image_format) {
  const r = await authedFetch(`${LOLAPI_BASE}/board/legacy-write/images/pending`, {
    method: 'POST', body: JSON.stringify({ image_id, image_format })
  }, { 'Content-Type': 'application/json' }).catch(() => null);
  return !!(r && r.ok);
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

  // ── 내 프로필(닉네임/스택/아바타) 최신값 — 다른 앱에서 아이콘 변경 시 새로고침으로 즉시 반영 ──
  if (msg.kind === 'profile') {
    respond(sendResponse, authedFetch(`${LOLAPI_BASE}/users/me`, {}));
    return true;
  }

  // 게시글 추천/비추천 (앱과 동일 엔드포인트 → 서버가 토글/취소 규칙을 동일하게 적용)
  if (msg.kind === 'vote') {
    (async () => {
      const body = { action: p.action === 'down' ? 'down' : 'up' };   // LegacyPostVote: action ∈ {up,down}
      const r = await authedFetch(`${LOLAPI_BASE}/board/legacy-write/posts/${enc(p.post_seq)}/vote`,
        { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' });
      const data = await r.json().catch(() => null);
      sendResponse({ ok: r.status >= 200 && r.status < 300, status: r.status, data });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }



  // ── 글쓰기 (원본 유지가 필요한 이미지(WebP)가 첨부된 경우에만 확장이 처리) ──
  //    사이트와 동일 순서: 이미지 업로드 → pending 등록 → 글 작성
  if (msg.kind === 'writePost') {
    (async () => {
      let image_id = '', image_format = '', image_error = '';
      if (p.image) {
        const up = await uploadImage(p.image, p.image_format);
        if (up.ok) { image_id = up.image_id; image_format = up.image_format; await registerPending(image_id, image_format); }
        else { image_error = up.error || 'unknown'; console.log('[cth-bg] writePost image upload failed:', image_error); }
      }
      const body = {
        title: p.title || '',
        body: p.body || '',
        youtube_url: p.youtube_url || '',
        image_id: image_id,
        image_format: image_format,
        notice: false,
        request_id: p.request_id
      };
      const r = await authedFetch(`${LOLAPI_BASE}/board/legacy-write/posts`,
        { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' });
      const data = await r.json().catch(() => null);
      console.log('[cth-bg] writePost', r.status, data);
      sendResponse({ ok: r.status >= 200 && r.status < 300, status: r.status, data,
        image_ok: !p.image || !!image_id, image_error: image_error });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 답글 작성 (사이트는 parent_id 를 0 으로 고정해 보내므로 답글만 확장이 처리) ──
  //    사이트와 동일 순서: 이미지 업로드 → pending 등록 → 댓글 작성(parent_id 포함)
  if (msg.kind === 'writeComment') {
    (async () => {
      let image_id = '', image_format = '', image_error = '';
      if (p.image) {
        const up = await uploadImage(p.image, p.image_format);
        if (up.ok) { image_id = up.image_id; image_format = up.image_format; await registerPending(image_id, image_format); }
        else { image_error = up.error || 'unknown'; console.log('[cth-bg] writeComment image upload failed:', image_error); }
      }
      const body = {
        body: p.body || '',
        parent_id: Number(p.parent_id) || 0,
        mention_user_id: '',
        image_id: image_id,
        image_format: image_format,
        request_id: p.request_id
      };
      const r = await authedFetch(`${LOLAPI_BASE}/board/legacy-write/posts/${enc(p.post_seq)}/comments`,
        { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' });
      const data = await r.json().catch(() => null);
      console.log('[cth-bg] writeComment', r.status, data);
      sendResponse({ ok: r.status >= 200 && r.status < 300, status: r.status, data,
        image_ok: !p.image || !!image_id, image_error: image_error });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 닉네임 변경 ──
  //    사이트 경로는 서버가 일부 실패 코드만 처리해, 24시간 제한 같은 거부가 그대로 사라진다.
  //    확장이 직접 호출해 서버 응답(상태·메시지)을 그대로 돌려주고 화면에 알린다.
  if (msg.kind === 'changeNickname') {
    (async () => {
      const meR = await authedFetch(`${LOLAPI_BASE}/users/me`, {});
      const meJ = await meR.json().catch(() => null);
      const u = (meJ && (meJ.user || meJ.data || meJ)) || {};
      const localKey = u.local_user_key || p.local_user_key || '';
      if (!localKey) { sendResponse({ ok: false, error: '프로필을 확인할 수 없습니다(로그인 필요)' }); return; }
      // /users 는 전체 프로필을 덮어쓰므로 기존 값들을 함께 보낸다(닉네임만 교체)
      const body = { local_user_key: localKey, nickname: p.nickname };
      if (u.motto != null) body.motto = u.motto;
      if (u.avatar_image_id) body.avatar_image_id = u.avatar_image_id;
      if (u.fixed_image_id) body.fixed_image_id = u.fixed_image_id;
      const r = await authedFetch(`${LOLAPI_BASE}/users`,
        { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' });
      const data = await r.json().catch(() => null);
      console.log('[cth-bg] changeNickname', r.status, data);
      // 200 이어도 본문이 실패를 알리는 경우가 있어 status 필드까지 확인한다
      const okBody = !data || data.status == null || String(data.status).toUpperCase() === 'OK';
      sendResponse({ ok: r.status >= 200 && r.status < 300 && okBody, status: r.status, data,
                     nickname: (data && data.user && data.user.nickname) || '' });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 고정짤 설정/해제 ──
  //    신 API 는 고정짤을 유저 프로필의 fixed_image_id 로 관리한다(사이트 changeIcon 과 동일 패턴).
  //    등록: 이미지 업로드 → /users/images/pending → POST /users { ..., fixed_image_id }
  //    해제: POST /users { ..., clear_fixed_image: true }
  //    ※ /users 는 전체 프로필을 덮어쓰므로 기존 닉네임·모토·아바타를 함께 보내야 지워지지 않는다.
  if (msg.kind === 'fixedImage') {
    (async () => {
      const meR = await authedFetch(`${LOLAPI_BASE}/users/me`, {});
      const meJ = await meR.json().catch(() => null);
      const u = (meJ && (meJ.user || meJ.data || meJ)) || {};
      const localKey = u.local_user_key || p.local_user_key || '';
      if (!localKey) { sendResponse({ ok: false, error: '프로필을 확인할 수 없습니다(로그인 필요)' }); return; }

      const body = { local_user_key: localKey };
      if (u.nickname) body.nickname = u.nickname;
      if (u.motto != null) body.motto = u.motto;
      if (u.avatar_image_id) body.avatar_image_id = u.avatar_image_id;

      if (p.clear) {
        body.clear_fixed_image = true;
      } else {
        const up = await uploadImage(p.image, 'jpg');   // 고정짤은 정지 이미지
        if (!up.ok) { sendResponse({ ok: false, error: '이미지 업로드 실패: ' + up.error }); return; }
        // 유저 이미지 pending 등록(게시판용과 엔드포인트가 다름)
        await authedFetch(`${LOLAPI_BASE}/users/images/pending`,
          { method: 'POST', body: JSON.stringify({ image_id: up.image_id }) },
          { 'Content-Type': 'application/json' }).catch(() => null);
        body.fixed_image_id = up.image_id;
      }
      const r = await authedFetch(`${LOLAPI_BASE}/users`,
        { method: 'POST', body: JSON.stringify(body) }, { 'Content-Type': 'application/json' });
      const data = await r.json().catch(() => null);
      console.log('[cth-bg] fixedImage', p.clear ? 'clear' : 'set', r.status, data && data.status);
      sendResponse({ ok: r.status >= 200 && r.status < 300, status: r.status, data });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  // ── 차단 목록/해제 (앱 '내 정보 → 차단 관리'와 동일 엔드포인트) ──
  //    목록: GET /blocks?local_user_key=...  → {results:[{id,nickname,avatar_url,created_at}], block_limit}
  //    해제: POST /blocks {blocker_local_user_key, blocked_user_id, blocked:false}
  if (msg.kind === 'blocks') {
    respond(sendResponse, authedFetch(`${LOLAPI_BASE}/blocks?local_user_key=${enc(p.local_user_key || '')}`, {}));
    return true;
  }
  // 차단 대상의 숫자 user id 조회 (구 post_seq → 신 글 상세의 author.id)
  if (msg.kind === 'authorNumId') {
    (async () => {
      const id = await resolveNewId(p.post_seq, p.author_id);
      if (!id) { sendResponse({ ok: false, error: '글 정보를 확인하지 못했습니다.' }); return; }
      const r = await fetch(`${LOLAPI_BASE}/board/posts/${enc(id)}`, { headers: LOLAPI_HEADERS }).catch(() => null);
      const j = r && await r.json().catch(() => null);
      const pp = j && (j.post || j.data || j);
      const a = pp && pp.author;
      sendResponse(a && a.id != null
        ? { ok: true, author_id: a.id, nickname: a.nickname }
        : { ok: false, error: '작성자 정보를 확인하지 못했습니다.' });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.kind === 'blockUser') {
    respond(sendResponse, authedFetch(`${LOLAPI_BASE}/blocks`, {
      method: 'POST',
      body: JSON.stringify({
        blocker_local_user_key: p.local_user_key,
        blocked_user_id: Number(p.blocked_user_id),
        blocked: p.blocked === true            // 기본은 해제(false)
      })
    }, { 'Content-Type': 'application/json' }));
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

  // ── 읽기 (GET) — 글 상세는 '내 추천 상태(vote)'를 얻기 위해서만 사용한다.
  //    (목록·댓글 등 게시판 데이터는 DJ 사이트가 직접 가져오므로 확장은 조회하지 않는다)
  let url;
  if (msg.kind === 'detail') {
    url = `${LOLAPI_BASE}/legacy-read-compat/post?post_seq=${enc(p.post_seq)}`;
    if (p.local_user_key) url += `&local_user_key=${enc(p.local_user_key)}`;   // 내 추천 상태(vote) 수신용
  } else {
    sendResponse({ ok: false, error: 'unknown kind: ' + msg.kind });
    return true;
  }

  authedFetch(url, {})                           // 로그인 시 vote 상태를 받기 위해 Bearer 첨부
    .then(r => r.json())
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async sendResponse
});
