(() => {
  if (window.__chatToolsHelperInstalled) return;
  window.__chatToolsHelperInstalled = true;

  const CFG = {
    chat: '#chat',
    message: '#chat > .chat_balloon.me.chat, #chat > .chat_balloon.other.chat',
    input: '#chat_input',
    send: '#chat_send',
    userLabel: '#djlist_users label',
    dropdownId: 'cth-mention-dropdown',
    replyBarId: 'cth-reply-bar',
    styleId: 'cth-style'
  };

  const state = {
    initialized: false,
    replyTarget: null,
    currentUsers: [],
    dropdownVisible: false,
    dropdownItems: [],
    selectedIndex: 0,
    scanScheduled: false,
    observer: null,
    themeObserver: null,
    chatHistory: [],
    historyIndex: -1,
    historySaved: ''
  };

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $all(sel, root = document) {
    return [...root.querySelectorAll(sel)];
  }

  function getChat() { return $(CFG.chat); }
  function getInput() { return $(CFG.input); }
  function getSendBtn() { return $(CFG.send); }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function normalizeText(str) {
    return String(str || '').replace(/\s+/g, ' ').trim();
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function injectStyle() {
    if (document.getElementById(CFG.styleId)) return;
    const style = document.createElement('style');
    style.id = CFG.styleId;
    style.textContent = `
      .chat_balloon.me.chat,
      .chat_balloon.other.chat {
        position: relative;
      }

      .cth-reply-btn {
        position: absolute;
        bottom: 4px;
        right: 4px;
        border: none;
        background: rgba(0,0,0,0.08);
        color: #111;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        border-radius: 6px;
        padding: 4px 6px;
        display: none;
        z-index: 5;
      }

      .chat_balloon.me.chat:hover .cth-reply-btn,
      .chat_balloon.other.chat:hover .cth-reply-btn {
        display: inline-block;
      }

      #${CFG.replyBarId} {
        display: none;
        position: absolute;
        left: 0;
        right: 72px;
        bottom: calc(100% + 6px);
        z-index: 50;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid rgba(0,0,0,0.10);
        background: rgba(245,245,245,0.98);
        border-radius: 8px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.08);
        font-size: 12px;
        line-height: 1.45;
      }

      #${CFG.replyBarId}.show { display: block; }
      #${CFG.replyBarId} .cth-reply-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
        font-weight: 700;
      }
      #${CFG.replyBarId} .cth-reply-cancel {
        border: none;
        background: transparent;
        cursor: pointer;
        font-size: 12px;
        padding: 2px 4px;
      }
      #${CFG.replyBarId} .cth-reply-preview {
        color: rgba(0,0,0,0.64);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      html.cth-theme-dark .cth-reply-btn {
        background: rgba(255,255,255,0.14);
        color: #f5f5f5;
      }

      html.cth-theme-dark #${CFG.replyBarId} {
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(34,34,34,0.98);
        color: #f3f3f3;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
      }

      html.cth-theme-dark #${CFG.replyBarId} .cth-reply-preview,
      html.cth-theme-dark #${CFG.replyBarId} .cth-reply-cancel {
        color: rgba(255,255,255,0.80);
      }

      .cth-reply-bubble {
        margin: 1px 0 2px;
        padding: 1px 7px 2px;
        background: rgba(0,0,0,0.05);
        border-left: 3px solid rgba(0,0,0,0.18);
        border-radius: 4px;
        color: rgba(0,0,0,0.62);
        cursor: pointer;
        font-size: 11px;
        line-height: 1.2;
        max-width: 100%;
        box-sizing: border-box;
      }
      .cth-reply-bubble:hover { background: rgba(0,0,0,0.09); }
      .cth-reply-bubble .cth-reply-meta {
        font-weight: 700;
        margin-bottom: 0;
      }
      .cth-reply-bubble > div:last-child {
        font-size: 12px;
      }
      .cth-reply-bubble .cth-reply-meta-me {
        color: crimson;
      }
      html.cth-theme-dark .cth-reply-bubble .cth-reply-meta-me {
        color: #d77a7a;
      }

      /* 답장 색상 구분: 내 채팅에 대한 답장 (내가 받은 답장) */
      .cth-reply-bubble.cth-reply-to-me {
        border-left: 3px solid #f59f00;
        background: rgba(245,159,0,0.10);
      }
      .cth-reply-bubble.cth-reply-to-me:hover {
        background: rgba(245,159,0,0.16);
      }
      /* 답장 색상 구분: 내가 보낸 답장 */
      .cth-reply-bubble.cth-reply-from-me {
        border-left: 3px solid #339af0;
        background: rgba(51,154,240,0.10);
      }
      .cth-reply-bubble.cth-reply-from-me:hover {
        background: rgba(51,154,240,0.16);
      }

      html.cth-theme-dark .cth-reply-bubble {
        background: rgba(255,255,255,0.08);
        border-left: 3px solid rgba(255,255,255,0.22);
        color: rgba(255,255,255,0.82);
      }
      html.cth-theme-dark .cth-reply-bubble:hover {
        background: rgba(255,255,255,0.12);
      }

      /* 다크모드 답장 색상 구분 */
      html.cth-theme-dark .cth-reply-bubble.cth-reply-to-me {
        border-left: 3px solid #f59f00;
        background: rgba(245,159,0,0.15);
      }
      html.cth-theme-dark .cth-reply-bubble.cth-reply-to-me:hover {
        background: rgba(245,159,0,0.22);
      }
      html.cth-theme-dark .cth-reply-bubble.cth-reply-from-me {
        border-left: 3px solid #339af0;
        background: rgba(51,154,240,0.15);
      }
      html.cth-theme-dark .cth-reply-bubble.cth-reply-from-me:hover {
        background: rgba(51,154,240,0.22);
      }

      .cth-reply-highlight {
        animation: cthReplyFlash 1.4s ease;
      }
      @keyframes cthReplyFlash {
        0% { box-shadow: 0 0 0 0 rgba(255,221,87,0.90); }
        35% { box-shadow: 0 0 0 6px rgba(255,221,87,0.55); }
        100% { box-shadow: 0 0 0 0 rgba(255,221,87,0); }
      }

      #${CFG.dropdownId} {
        position: fixed;
        z-index: 2147483647;
        min-width: 220px;
        max-width: 320px;
        max-height: 240px;
        overflow-y: auto;
        background: #1f1f1f;
        color: #fff;
        border: 1px solid #444;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.28);
        padding: 6px 0;
        font-size: 14px;
        display: none;
      }
      #${CFG.dropdownId} .cth-item {
        padding: 6px 12px;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #${CFG.dropdownId} .cth-item img {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        flex-shrink: 0;
        object-fit: cover;
      }
      #${CFG.dropdownId} .cth-item:hover,
      #${CFG.dropdownId} .cth-item.active {
        background: #333;
      }
      #${CFG.dropdownId} .cth-empty {
        padding: 8px 12px;
        color: #aaa;
      }

      /* ============ 자유게시판 컴팩트(단일 컬럼) 모드 ============ */
      :root {
        --cth-board-w: 485px;      /* #lol_lpanel 폭과 동일 */
        --cth-mainchat-w: 350px;   /* 런타임에 실제 채팅창 폭으로 갱신 */
      }

      /* 게시판 패널을 왼쪽 목록 폭(485px) 하나로 고정 */
      html.cth-compact #lol_panel {
        width: var(--cth-board-w) !important;
      }

      /* 내용(rpanel)/글쓰기(lol_write)를 목록 위에 겹치는 오버레이로 전환 */
      html.cth-compact #lol_rpanel,
      html.cth-compact #lol_write {
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        width: var(--cth-board-w) !important;
        max-width: var(--cth-board-w) !important;
        height: 100% !important;
        z-index: 5 !important;
        box-sizing: border-box !important;
        background-color: var(--롤백_배경색);
      }
      html.cth-compact #lol_rpanel_body { overflow-y: auto !important; }

      /* 기본(목록 뷰)에서는 오버레이 숨김 */
      html.cth-compact #lol_rpanel { display: none !important; }
      html.cth-compact #lol_write  { display: none !important; }
      /* 내용 뷰 / 글쓰기 뷰에서만 각각 표시 */
      html.cth-compact #lol_panel.cth-view-detail #lol_rpanel { display: block !important; }
      html.cth-compact #lol_panel.cth-view-write  #lol_write  { display: flex !important; }

      /* '← 목록' 되돌아가기 버튼 — 내용 뷰 헤더의 우측 하단('[차단하기]' 우측, 새로고침 버튼 아래)에
         작게 배치. 헤더에 position:relative만 주고 절대배치라 다른 요소는 밀리지 않음.
         (글쓰기 뷰는 기존 '취소' 버튼이 목록 복귀를 담당) */
      html.cth-compact #lol_rpanel_header { position: relative; }
      #cth-board-back-detail {
        display: none;
        position: absolute;
        right: 0;
        bottom: 0;
        z-index: 10;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: bold;
        color: #fff;
        background: rgba(0,0,0,0.55);
        border-radius: 7px;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      #cth-board-back-detail:hover { background: rgba(0,0,0,0.75); }
      html.cth-compact #lol_panel.cth-view-detail #cth-board-back-detail { display: block !important; }

      /* 목록 전용 하단 버튼(검색/글쓰기)은 z-index:31이라 오버레이(z-index:5) 위로 떠버림 →
         내용/글쓰기 뷰에서는 숨기고, 목록 뷰에서만 보이도록 */
      html.cth-compact #lol_panel.cth-view-detail #lol_lpanel_search_button,
      html.cth-compact #lol_panel.cth-view-detail #lol_lpanel_write_button,
      html.cth-compact #lol_panel.cth-view-write  #lol_lpanel_search_button,
      html.cth-compact #lol_panel.cth-view-write  #lol_lpanel_write_button {
        display: none !important;
      }

      /* 아이콘 등록 뷰: #lol_rpanel_body가 margin-right:0(왼쪽만 15px)이라 좁은 컬럼에서
         붙여넣기 영역/캔버스/슬라이더가 우측으로 쏠려 보임 → 우측 여백 보정으로 가운데 정렬 */
      html.cth-compact #lol_rpanel_body_icon_change_placeholder,
      html.cth-compact #lol_rpanel_body_icon_change_canvas_container,
      html.cth-compact #lol_rpanel_body_icon_change_size_slider {
        margin-right: 15px !important;
      }

      /* 게시판 열림 + 컴팩트: 영상을 오른쪽 공간으로 축소·이동 */
      html.cth-compact.cth-board-open #video_player,
      html.cth-compact.cth-board-open #m3u8_player,
      html.cth-compact.cth-board-open #flv_player,
      html.cth-compact.cth-board-open #twitch_player_panel,
      html.cth-compact.cth-board-open #block_video,
      html.cth-compact.cth-board-open #marquee_screen {
        left: var(--cth-board-w) !important;
        width: calc(100vw - var(--cth-mainchat-w) - var(--cth-board-w)) !important;
      }

      /* 컴팩트 모드 전환 애니메이션 복구
         - 목록→내용/글쓰기로 전환 시 오버레이가 살짝 슬라이드하며 나타남
         - 게시판 열림/닫힘 시 영상이 오른쪽으로 부드럽게 축소·이동 */
      /* 목록 → 내용/글쓰기: 오버레이가 오른쪽에서 슬라이드-인 */
      @keyframes cthCompactOverlayIn {
        from { opacity: 0; transform: translateX(24px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      html.cth-compact #lol_panel.cth-view-detail #lol_rpanel,
      html.cth-compact #lol_panel.cth-view-write  #lol_write {
        animation: cthCompactOverlayIn 0.22s ease;
      }
      /* 내용/글쓰기 → 목록(및 닉네임 우클릭으로 작성자 글 목록): 반대 방향(왼쪽에서) 슬라이드-인 */
      @keyframes cthCompactListIn {
        from { opacity: 0; transform: translateX(-24px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      html.cth-compact #lol_panel.cth-view-list #lol_lpanel {
        animation: cthCompactListIn 0.22s ease;
      }
      html.cth-compact #video_player,
      html.cth-compact #m3u8_player,
      html.cth-compact #flv_player,
      html.cth-compact #twitch_player_panel,
      html.cth-compact #block_video,
      html.cth-compact #marquee_screen {
        transition: left 0.24s ease, width 0.24s ease;
      }

      /* 자유게시판 댓글 본문의 '@닉네임' 멘션 강조 (플레인 텍스트와 구분) */
      .cth-mention {
        color: #1971c2;
        background: rgba(51, 154, 240, 0.16);
        border-radius: 4px;
        padding: 0 3px;
        font-weight: bold;
      }
      html.cth-theme-dark .cth-mention {
        color: #a5d8ff;
        background: rgba(51, 154, 240, 0.24);
      }
    `;
    document.head.appendChild(style);
  }

  function ensureReplyBar() {
    let bar = document.getElementById(CFG.replyBarId);
    if (bar) return bar;
    const input = getInput();
    if (!input || !input.parentElement) return null;
    const wrapper = input.parentElement;
    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'visible';
    bar = document.createElement('div');
    bar.id = CFG.replyBarId;
    wrapper.appendChild(bar);
    bar.addEventListener('click', (e) => {
      const cancel = e.target.closest('.cth-reply-cancel');
      if (cancel) {
        e.preventDefault();
        clearReplyTarget();
      }
    });
    return bar;
  }

  function ensureDropdown() {
    let dd = document.getElementById(CFG.dropdownId);
    if (dd) return dd;
    dd = document.createElement('div');
    dd.id = CFG.dropdownId;
    document.body.appendChild(dd);
    return dd;
  }

  function getUsers() {
    const users = $all(CFG.userLabel)
      .map(el => {
        const nick = normalizeText(el.textContent);
        if (!nick) return null;
        const li = el.closest('li');
        const img = li && li.querySelector('img.chat_profile');
        return { nick, iconSrc: img ? img.src : '' };
      })
      .filter(Boolean);
    const seen = new Set();
    state.currentUsers = users.filter(u => {
      if (seen.has(u.nick)) return false;
      seen.add(u.nick);
      return true;
    });
    return state.currentUsers;
  }

  function getMentionState(value, caretPos) {
    const before = value.slice(0, caretPos);
    // /vol 은 입력 시작 부분에서만 작동
    const volMatch = before.match(/^\/vol\s([^\s]*)$/);
    if (volMatch) {
      return {
        query: volMatch[1],
        start: 0,
        end: caretPos,
        trigger: 'vol'
      };
    }
    const atMatch = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (atMatch) {
      return {
        query: atMatch[1],
        start: before.lastIndexOf('@'),
        end: caretPos,
        trigger: 'at'
      };
    }
    return null;
  }

  function placeDropdown() {
    const input = getInput();
    const dd = ensureDropdown();
    if (!input) return;
    const rect = input.getBoundingClientRect();
    dd.style.left = `${rect.left}px`;
    dd.style.top = `${rect.top - dd.offsetHeight - 8}px`;
    if ((rect.top - dd.offsetHeight - 8) < 0) {
      dd.style.top = `${rect.bottom + 8}px`;
    }
  }

  function hideDropdown() {
    const dd = ensureDropdown();
    dd.style.display = 'none';
    state.dropdownVisible = false;
    state.dropdownItems = [];
    state.selectedIndex = 0;
  }

  function refreshDropdownActive() {
    const dd = ensureDropdown();
    const items = [...dd.querySelectorAll('.cth-item')];
    items.forEach((el, idx) => {
      el.classList.toggle('active', idx === state.selectedIndex);
    });
  }

  function scrollActiveIntoView() {
    const dd = ensureDropdown();
    const items = [...dd.querySelectorAll('.cth-item')];
    const active = items[state.selectedIndex];
    if (!active) return;
    const itemTop = active.offsetTop;
    const itemBottom = itemTop + active.offsetHeight;
    const viewTop = dd.scrollTop;
    const viewBottom = viewTop + dd.clientHeight;
    if (itemTop < viewTop) dd.scrollTop = itemTop;
    else if (itemBottom > viewBottom) dd.scrollTop = itemBottom - dd.clientHeight;
  }

  function scrollPageToActive(align) {
    const dd = ensureDropdown();
    const items = [...dd.querySelectorAll('.cth-item')];
    const active = items[state.selectedIndex];
    if (!active) return;
    if (align === 'top') {
      dd.scrollTop = active.offsetTop;
    } else {
      dd.scrollTop = active.offsetTop + active.offsetHeight - dd.clientHeight;
    }
  }

  function insertMention(name) {
    const input = getInput();
    if (!input) return;
    const value = input.value;
    const caretPos = input.selectionStart ?? 0;
    const mention = getMentionState(value, caretPos);
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(mention.end);
    const inserted = mention.trigger === 'vol'
      ? `/vol ${name}`
      : `@${name} `;
    input.value = before + inserted + after;
    const pos = (before + inserted).length;
    input.focus();
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    hideDropdown();
  }

  function renderDropdown(items) {
    const dd = ensureDropdown();
    dd.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'cth-empty';
      empty.textContent = '일치하는 유저 없음';
      dd.appendChild(empty);
    } else {
      items.forEach((u, idx) => {
        const item = document.createElement('div');
        item.className = 'cth-item' + (idx === state.selectedIndex ? ' active' : '');
        if (u.iconSrc) {
          const icon = document.createElement('img');
          icon.src = u.iconSrc;
          item.appendChild(icon);
        }
        item.appendChild(document.createTextNode(u.nick));
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          insertMention(u.nick);
        });
        dd.appendChild(item);
      });
    }
    dd.style.display = 'block';
    placeDropdown();
    state.dropdownVisible = true;
    scrollActiveIntoView();
  }

  function updateDropdown() {
    const input = getInput();
    if (!input) return hideDropdown();
    const value = input.value;
    const caretPos = input.selectionStart ?? 0;
    const mention = getMentionState(value, caretPos);
    if (!mention) return hideDropdown();
    const q = mention.query.toLowerCase();
    const filtered = getUsers().filter(u => u.nick.toLowerCase().includes(q)).slice(0, 30);
    state.dropdownItems = filtered;
    if (state.selectedIndex >= filtered.length) state.selectedIndex = 0;
    renderDropdown(filtered);
  }

  function getMessageTemp(msgEl) { return $('temp', msgEl); }

  function parseReplyMarker(text) {
    const raw = String(text || '');
    const trimmed = raw.replace(/^\s+/, '');
    const m = trimmed.match(/^⟦r:([a-z0-9]+)⟧([\s\S]*)$/i);
    if (!m) return null;
    return { key: m[1], body: m[2] || '' };
  }

  function getMessageText(msgEl) {
    const temp = getMessageTemp(msgEl);
    if (temp) {
      const raw = temp.dataset.cthRawText ?? temp.textContent ?? '';
      const cleaned = normalizeText(raw.replace(/^\s*⟦r:[a-z0-9]+⟧/i, ''));
      if (cleaned) return cleaned;
    }
    const media = $('img.chat_img, video.chat_img', msgEl);
    if (media) return '[이미지]';
    return temp ? '' : '[내용 없음]';
  }

  function getMessageAuthor(msgEl) {
    const nick = $('.nick', msgEl);
    return nick ? normalizeText(nick.textContent) : '알 수 없음';
  }

  function getMessageTime(msgEl) {
    const time = $('.chat_time', msgEl);
    return time ? normalizeText(time.textContent) : '';
  }

  function buildStableMessageKey(msgEl) {
    return hashString(`${getMessageAuthor(msgEl)}|${getMessageTime(msgEl)}|${getMessageText(msgEl)}`);
  }

  /* page_bridge.js (world:MAIN)가 g_nick을 dataset에 동기화해줌 */
  function getMyNick() {
    return document.documentElement.dataset.cthMyNick || '';
  }

  function playReplyNotificationSound() {
    window.dispatchEvent(new Event('cth-play-reply-sound'));
  }

  function createReplyBubble(targetMsgEl, replyMsgEl) {
    const bubble = document.createElement('div');
    bubble.className = 'cth-reply-bubble';
    bubble.dataset.replyTargetKey = targetMsgEl.dataset.cthMsgKey || '';

    // 답장 색상 구분
    const myNick = getMyNick();
    const targetAuthor = getMessageAuthor(targetMsgEl);
    const replyAuthor = replyMsgEl ? getMessageAuthor(replyMsgEl) : '';
    if (myNick && targetAuthor === myNick && replyAuthor !== myNick) {
      // 내 채팅에 다른 사람이 답장함 (노란색)
      bubble.classList.add('cth-reply-to-me');
    } else if (myNick && replyAuthor === myNick && targetAuthor !== myNick) {
      // 내가 다른 사람에게 답장함 (파란색)
      bubble.classList.add('cth-reply-from-me');
    }

    const isTargetMe = myNick && targetAuthor === myNick;
    const nickClass = isTargetMe ? ' cth-reply-meta-me' : '';
    bubble.innerHTML = `
      <div class="cth-reply-meta"><span class="${nickClass}">${escapeHtml(targetAuthor)}</span> | ${escapeHtml(getMessageTime(targetMsgEl))}</div>
      <div>${escapeHtml(getMessageText(targetMsgEl))}</div>
    `;
    bubble.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpToOriginal(targetMsgEl);
    });
    return bubble;
  }

  function attachReplyBubble(msgEl, targetMsgEl) {
    if (!msgEl || !targetMsgEl) return;
    let existing = msgEl.querySelector('.cth-reply-bubble');
    const nextKey = targetMsgEl.dataset.cthMsgKey || '';
    if (existing) {
      if (existing.dataset.replyTargetKey === nextKey) return;
      existing.remove();
    }
    const bubble = createReplyBubble(targetMsgEl, msgEl);

    // 내 채팅에 대한 답장이면 알림 소리 재생
    const myNick = getMyNick();
    const targetAuthor = getMessageAuthor(targetMsgEl);
    const replyAuthor = getMessageAuthor(msgEl);
    if (myNick && targetAuthor === myNick && replyAuthor !== myNick) {
      if (!msgEl.dataset.cthNotified) {
        msgEl.dataset.cthNotified = '1';
        playReplyNotificationSound();
      }
    }

    const temp = getMessageTemp(msgEl);
    const img = $('img.chat_img', msgEl);

    // 버블 삽입 전 스크롤 하단 고정 여부 확인
    const chat = getChat();
    const wasAtBottom = chat
      ? (chat.scrollHeight - chat.scrollTop <= chat.clientHeight + 30)
      : false;

    if (temp) msgEl.insertBefore(bubble, temp);
    else if (img) msgEl.insertBefore(bubble, img);
    else msgEl.appendChild(bubble);

    // 하단 고정 상태였으면 버블 높이만큼 스크롤 보정
    if (wasAtBottom && chat) {
      chat.scrollTop = chat.scrollHeight - chat.clientHeight;
    }
  }

  function jumpToOriginal(targetMsgEl) {
    if (!targetMsgEl) return;
    const chat = getChat();
    if (chat) {
      const chatRect = chat.getBoundingClientRect();
      const msgRect = targetMsgEl.getBoundingClientRect();
      const offset = msgRect.top - chatRect.top - chatRect.height / 2 + msgRect.height / 2;
      chat.scrollBy({ top: offset, behavior: 'smooth' });
    }
    targetMsgEl.classList.add('cth-reply-highlight');
    setTimeout(() => targetMsgEl.classList.remove('cth-reply-highlight'), 1500);
  }

  function setReplyTarget(msgEl) {
    if (!msgEl.dataset.cthMsgKey) msgEl.dataset.cthMsgKey = buildStableMessageKey(msgEl);
    state.replyTarget = {
      key: msgEl.dataset.cthMsgKey,
      author: getMessageAuthor(msgEl),
      time: getMessageTime(msgEl),
      text: getMessageText(msgEl)
    };
    renderReplyBar();
    const input = getInput();
    if (input) input.focus();
  }

  function clearReplyTarget() {
    state.replyTarget = null;
    renderReplyBar();
  }

  function renderReplyBar() {
    const bar = ensureReplyBar();
    if (!bar) return;
    if (!state.replyTarget) {
      bar.classList.remove('show');
      bar.innerHTML = '';
      return;
    }
    bar.innerHTML = `
      <div class="cth-reply-top">
        <span>답장 중</span>
        <button type="button" class="cth-reply-cancel">취소</button>
      </div>
      <div class="cth-reply-preview">${escapeHtml(state.replyTarget.author)} | ${escapeHtml(state.replyTarget.time)}\n${escapeHtml(state.replyTarget.text)}</div>
    `;
    bar.classList.add('show');
  }

  function injectReplyMarkerIfNeeded() {
    const input = getInput();
    if (!input || !state.replyTarget) return;
    const current = input.value || '';
    if (!normalizeText(current)) return;
    if (/^\s*⟦r:[a-z0-9]+⟧/i.test(current)) return;
    input.value = `⟦r:${state.replyTarget.key}⟧${current}`;
    clearReplyTarget();
  }

  function transformMessage(msgEl) {
    if (!msgEl) return;
    const temp = getMessageTemp(msgEl);
    if (temp) {
      const liveText = temp.textContent || '';
      const currentRaw = temp.dataset.cthRawText;
      const parsedAlready = temp.dataset.cthReplyParsed === '1';
      if (!currentRaw) {
        temp.dataset.cthRawText = liveText;
      } else if (!parsedAlready && currentRaw !== liveText) {
        temp.dataset.cthRawText = liveText;
      }
    }

    if (!msgEl.dataset.cthMsgKey) msgEl.dataset.cthMsgKey = buildStableMessageKey(msgEl);

    if (!msgEl.querySelector('.cth-reply-btn')) {
      const btn = document.createElement('button');
      btn.className = 'cth-reply-btn';
      btn.type = 'button';
      btn.textContent = '↩';
      btn.title = '답장';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setReplyTarget(msgEl);
      });
      msgEl.appendChild(btn);
    }

    if (!temp) return;
    const parsed = parseReplyMarker(temp.dataset.cthRawText || temp.textContent || '');
    if (!parsed) return;

    const cleanBody = parsed.body.replace(/^\s+/, '');
    if (temp.textContent !== cleanBody) temp.textContent = cleanBody;
    temp.dataset.cthReplyParsed = '1';

    const messages = $all(CFG.message);
    const target = messages.find(el => {
      if (el === msgEl) return false;
      if (!el.dataset.cthMsgKey) el.dataset.cthMsgKey = buildStableMessageKey(el);
      return el.dataset.cthMsgKey === parsed.key;
    });
    if (target) {
      attachReplyBubble(msgEl, target);
    } else {
      // 원본 메시지를 찾을 수 없을 때 placeholder 버블 표시
      if (!msgEl.querySelector('.cth-reply-bubble')) {
        const chat = getChat();
        const wasAtBottom = chat
          ? (chat.scrollHeight - chat.scrollTop <= chat.clientHeight + 30)
          : false;

        const placeholder = document.createElement('div');
        placeholder.className = 'cth-reply-bubble';
        placeholder.style.clear = 'left';
        placeholder.innerHTML = `<div class="cth-reply-meta" style="opacity:0.5">원본 메시지를 찾을 수 없습니다</div>`;
        const tempEl = getMessageTemp(msgEl);
        const img = $('img.chat_img', msgEl);
        if (tempEl) msgEl.insertBefore(placeholder, tempEl);
        else if (img) msgEl.insertBefore(placeholder, img);
        else msgEl.appendChild(placeholder);

        if (wasAtBottom && chat) {
          chat.scrollTop = chat.scrollHeight - chat.clientHeight;
        }
      }
    }
  }

  function scanMessages() {
    const chat = getChat();
    if (!chat) return;
    const messages = $all(CFG.message, chat);
    for (const msg of messages) transformMessage(msg);
    getUsers();
  }

  function scheduleScan() {
    if (state.scanScheduled) return;
    state.scanScheduled = true;
    requestAnimationFrame(() => {
      state.scanScheduled = false;
      scanMessages();
    });
  }

  function installObserver() {
    const chat = getChat();
    if (!chat || state.observer) return;
    state.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          scheduleScan();
          return;
        }
      }
    });
    state.observer.observe(chat, { childList: true, subtree: false });
  }

  function onInput() {
    state.selectedIndex = 0;
    state.historyIndex = -1;
    updateDropdown();
  }

  function onKeydown(e) {
    const input = getInput();
    if (!input) return;

    // Escape: 드롭다운 닫기 + 답장 바 닫기
    if (e.key === 'Escape') {
      if (state.dropdownVisible) {
        hideDropdown();
        e.preventDefault();
        return;
      }
      if (state.replyTarget) {
        clearReplyTarget();
        e.preventDefault();
        return;
      }
      return;
    }

    if (e.key === 'Enter') {
      // 드롭다운이 열려있으면 Enter로 멘션 선택
      if (state.dropdownVisible && state.dropdownItems.length) {
        e.preventDefault();
        e.stopPropagation();
        insertMention(state.dropdownItems[state.selectedIndex].nick);
        return;
      }
      // 빈 메시지로 Enter 시 답장 바 해제
      const trimmed = normalizeText(input.value);
      if (!trimmed && state.replyTarget) {
        clearReplyTarget();
        return;
      }
      // 채팅 히스토리 저장 (답장 마커 주입 전)
      if (trimmed) {
        state.chatHistory.push(input.value);
        if (state.chatHistory.length > 50) state.chatHistory.shift();
        state.historyIndex = -1;
      }
      injectReplyMarkerIfNeeded();
      setTimeout(scheduleScan, 120);
      return;
    }

    // 채팅 히스토리 네비게이션 (드롭다운이 닫혀 있을 때)
    if (e.key === 'ArrowUp' && !state.dropdownVisible) {
      if (!state.chatHistory.length) return;
      e.preventDefault();
      e.stopPropagation();
      const nextIdx = state.historyIndex + 1;
      if (nextIdx >= state.chatHistory.length) return;
      if (state.historyIndex === -1) state.historySaved = input.value;
      state.historyIndex = nextIdx;
      input.value = state.chatHistory[state.chatHistory.length - 1 - nextIdx];
      setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 10);
      return;
    }

    if (e.key === 'ArrowDown' && !state.dropdownVisible) {
      if (state.historyIndex < 0) return;
      e.preventDefault();
      e.stopPropagation();
      state.historyIndex--;
      if (state.historyIndex < 0) {
        input.value = state.historySaved;
      } else {
        input.value = state.chatHistory[state.chatHistory.length - 1 - state.historyIndex];
      }
      setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 10);
      return;
    }

    if (!state.dropdownVisible) return;

    if (e.key === 'ArrowDown') {
      if (!state.dropdownItems.length) return;
      e.preventDefault();
      e.stopPropagation();
      // 맨 아래에서 아래 누르면 blocking (더 이상 안 내려감)
      if (state.selectedIndex >= state.dropdownItems.length - 1) return;
      state.selectedIndex = state.selectedIndex + 1;
      refreshDropdownActive();
      scrollActiveIntoView();
      return;
    }

    if (e.key === 'ArrowUp') {
      if (!state.dropdownItems.length) return;
      e.preventDefault();
      e.stopPropagation();
      // 맨 위에서 위 누르면 blocking
      if (state.selectedIndex <= 0) return;
      state.selectedIndex = state.selectedIndex - 1;
      refreshDropdownActive();
      scrollActiveIntoView();
      return;
    }

    if (e.key === 'PageDown') {
      if (!state.dropdownItems.length) return;
      e.preventDefault();
      e.stopPropagation();
      const dd = document.getElementById(CFG.dropdownId);
      const firstItem = dd && dd.querySelector('.cth-item');
      const pageSize = (dd && firstItem) ? Math.max(1, Math.floor(dd.clientHeight / firstItem.offsetHeight)) : 7;
      state.selectedIndex = Math.min(state.selectedIndex + pageSize, state.dropdownItems.length - 1);
      refreshDropdownActive();
      scrollPageToActive('top');
      return;
    }

    if (e.key === 'PageUp') {
      if (!state.dropdownItems.length) return;
      e.preventDefault();
      e.stopPropagation();
      const dd = document.getElementById(CFG.dropdownId);
      const firstItem = dd && dd.querySelector('.cth-item');
      const pageSize = (dd && firstItem) ? Math.max(1, Math.floor(dd.clientHeight / firstItem.offsetHeight)) : 7;
      state.selectedIndex = Math.max(state.selectedIndex - pageSize, 0);
      refreshDropdownActive();
      scrollPageToActive('bottom');
      return;
    }

    if (e.key === 'End') {
      if (!state.dropdownItems.length) return;
      e.preventDefault();
      e.stopPropagation();
      state.selectedIndex = state.dropdownItems.length - 1;
      refreshDropdownActive();
      scrollActiveIntoView();
      return;
    }

    if (e.key === 'Home') {
      if (!state.dropdownItems.length) return;
      e.preventDefault();
      e.stopPropagation();
      state.selectedIndex = 0;
      refreshDropdownActive();
      scrollActiveIntoView();
      return;
    }

    if (e.key === 'Tab') {
      if (!state.dropdownItems.length) return;
      e.preventDefault();
      e.stopPropagation();
      insertMention(state.dropdownItems[state.selectedIndex].nick);
      return;
    }
  }

  function onSendClick() {
    const input = getInput();
    const trimmed = input ? normalizeText(input.value) : '';
    if (trimmed) {
      state.chatHistory.push(input.value);
      if (state.chatHistory.length > 50) state.chatHistory.shift();
      state.historyIndex = -1;
    }
    injectReplyMarkerIfNeeded();
    setTimeout(scheduleScan, 120);
  }

  function installInputHandlers() {
    const input = getInput();
    const sendBtn = getSendBtn();
    if (!input || input.dataset.cthBound === '1') return;
    input.dataset.cthBound = '1';
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown, true);
    if (sendBtn && sendBtn.dataset.cthBound !== '1') {
      sendBtn.dataset.cthBound = '1';
      sendBtn.addEventListener('click', onSendClick, true);
    }
  }


  function isDarkTheme() {
    const htmlTheme = document.documentElement.getAttribute('theme');
    if (htmlTheme === 'dark') return true;
    if (htmlTheme === 'default') return false;

    const dark = document.getElementById('theme_dark');
    if (dark) return !!dark.checked;

    return document.documentElement.classList.contains('cth-theme-dark');
  }

  function applyThemeClass() {
    const root = document.documentElement;
    root.classList.toggle('cth-theme-dark', isDarkTheme());
  }

  function installThemeWatcher() {
    if (document.body.dataset.cthThemeBound === '1') return;
    document.body.dataset.cthThemeBound = '1';

    applyThemeClass();
    setTimeout(applyThemeClass, 0);
    setTimeout(applyThemeClass, 150);
    setTimeout(applyThemeClass, 600);

    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t && (t.id === 'theme_dark' || t.id === 'theme_default' || t.name === 'theme')) {
        applyThemeClass();
      }
    }, true);

    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t && (t.id === 'theme_dark' || t.id === 'theme_default')) {
        setTimeout(applyThemeClass, 0);
      }
    }, true);

    if (state.themeObserver) state.themeObserver.disconnect();
    state.themeObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'theme') {
          applyThemeClass();
          return;
        }
        if (m.type === 'childList') {
          if (document.getElementById('theme_dark') || document.getElementById('theme_default')) {
            applyThemeClass();
            return;
          }
        }
      }
    });

    state.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['theme'],
      childList: false,
      subtree: false
    });

    state.themeObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function installGlobalHandlers() {
    if (document.body.dataset.cthGlobalBound === '1') return;
    document.body.dataset.cthGlobalBound = '1';

    document.addEventListener('click', (e) => {
      const dd = ensureDropdown();
      const input = getInput();
      if (!dd.contains(e.target) && e.target !== input) hideDropdown();
    }, true);

    window.addEventListener('resize', () => {
      if (state.dropdownVisible) placeDropdown();
    });

    window.addEventListener('scroll', () => {
      if (state.dropdownVisible) placeDropdown();
    }, true);
  }

  /* ── 새로고침/뒤로가기/탭 닫기 시 실수 방지용 확인(blocking) ──
     브라우저 표준 이탈 확인창을 한 번 띄운다. 확인하면 정상 이동, 취소하면 페이지 유지.
     팝업 '설정'의 체크박스(cthUnloadGuard, 기본 켜짐)로 켜고 끈다. */
  function installUnloadGuard() {
    if (window.__cthUnloadGuardInit) return;
    window.__cthUnloadGuardInit = true;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };  // 크롬/엣지 이탈 확인창
    let bound = false;
    function apply(on) {
      if (on && !bound) { window.addEventListener('beforeunload', handler); bound = true; }
      else if (!on && bound) { window.removeEventListener('beforeunload', handler); bound = false; }
    }
    chrome.storage.local.get('cthUnloadGuard', (data) => apply(data.cthUnloadGuard !== false)); // 기본 ON
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.cthUnloadGuard) apply(changes.cthUnloadGuard.newValue !== false);
    });
  }

  function boot() {
    if (!getChat() || !getInput()) return;
    injectStyle();
    ensureReplyBar();
    ensureDropdown();
    renderReplyBar();
    installInputHandlers();
    installGlobalHandlers();
    installThemeWatcher();
    installObserver();
    scheduleScan();
    installLivechatBlocker();
    installProfileTracker();
    installMemoButton();
    installVolumeMemory();
    installBrokenIconFallback();
    installCompactBoard();
    installUnloadGuard();
    state.initialized = true;
  }

  /* ── 자유게시판 프로필 아이콘: default.png를 먼저 표시하고, 실제 아이콘은 로드 성공 시에만 교체 ── */
  function installBrokenIconFallback() {
    const DEFAULT_ICON = chrome.runtime.getURL('default.png');
    const ICON_SELECTOR = 'img[icon], #lol_lpanel_account_icon, #lol_rpanel_header_icon';

    function isIconImg(el) {
      return el instanceof HTMLImageElement && el.matches(ICON_SELECTOR);
    }

    function handleIcon(img) {
      const src = img.getAttribute('src');
      if (!src || src === DEFAULT_ICON) return;
      if (img.dataset.cthVerifiedSrc === src) return; // 이미 로드 확인된 아이콘
      if (img.dataset.cthPendingSrc === src) return;  // 이미 백그라운드 로드 중

      // 즉시 default로 표시하고 실제 아이콘은 백그라운드에서 로드
      img.dataset.cthPendingSrc = src;
      delete img.dataset.cthVerifiedSrc;
      img.src = DEFAULT_ICON;

      const probe = new Image();
      probe.onload = () => {
        if (img.dataset.cthPendingSrc !== src) return; // 그 사이 다른 src로 바뀜
        delete img.dataset.cthPendingSrc;
        img.dataset.cthVerifiedSrc = src;
        img.src = src; // 캐시에서 즉시 표시됨
      };
      probe.onerror = () => {
        if (img.dataset.cthPendingSrc !== src) return;
        delete img.dataset.cthPendingSrc; // default 유지
      };
      probe.src = src;
    }

    function scanIcons(root) {
      if (isIconImg(root)) handleIcon(root);
      if (root.querySelectorAll) {
        for (const img of root.querySelectorAll(ICON_SELECTOR)) handleIcon(img);
      }
    }

    // 새로 추가되는 아이콘 + 기존 아이콘의 src 변경 감지
    const iconObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          if (isIconImg(m.target)) handleIcon(m.target);
        } else if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) scanIcons(node);
          }
        }
      }
    });
    iconObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });

    // 이미 존재하는 아이콘 처리
    scanIcons(document.documentElement);
  }

  /* ── 볼륨 메모리 (도메인별 저장/복원) ── */
  function installVolumeMemory() {
    const storageKey = 'cthVolume_' + location.hostname;
    const slider = document.getElementById('video_info_volume_slider');
    const muteBtn = document.getElementById('video_info_volume_btn');
    if (!slider) return;

    // 저장된 볼륨 복원
    chrome.storage.local.get(storageKey, (data) => {
      const saved = data[storageKey];
      if (!saved) return;
      window.dispatchEvent(new CustomEvent('cth-restore-volume', {
        detail: { volume: saved.volume, muted: saved.muted }
      }));
    });

    // 볼륨 변경 감지 및 저장
    let saveTimer = null;
    function saveVolume() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const vol = parseInt(slider.value, 10);
        const muted = muteBtn && muteBtn.style.backgroundImage.includes('tts_x');
        chrome.storage.local.set({ [storageKey]: { volume: vol, muted: !!muted } });
      }, 300);
    }

    slider.addEventListener('input', saveVolume);
    slider.addEventListener('change', saveVolume);
    if (muteBtn) muteBtn.addEventListener('click', () => setTimeout(saveVolume, 150));

    // 폴링으로 변경 감지 (외부 요인으로 볼륨이 바뀐 경우 대비)
    let lastVol = -1;
    let lastMuted = null;
    setInterval(() => {
      const vol = parseInt(slider.value, 10);
      const muted = muteBtn && muteBtn.style.backgroundImage.includes('tts_x');
      if (vol !== lastVol || muted !== lastMuted) {
        lastVol = vol;
        lastMuted = muted;
        saveVolume();
      }
    }, 2000);
  }

  /* ── 쪽지함 버튼 주입 ── */
  function installMemoButton() {
    const container = document.getElementById('lol_lpanel_userinfo_menu_inner_background');
    if (!container) return;
    // 로그아웃 버튼 앞에 삽입
    const logoutBtn = document.getElementById('lol_lpanel_userinfo_menu_button_logout');
    if (!logoutBtn) return;

    const btn = document.createElement('div');
    btn.id = 'lol_lpanel_userinfo_menu_button_memo';
    btn.setAttribute('menu-button', '');
    btn.textContent = '쪽지함';
    container.insertBefore(btn, logoutBtn);

    btn.addEventListener('click', () => {
      const androidId = document.documentElement.dataset.cthLolAndroidId || '';
      if (!androidId) {
        alert('자유게시판 로그인이 필요합니다.');
        return;
      }
      // 팝업 창 열기
      const w = 480;
      const h = 640;
      const left = Math.round((screen.width - w) / 2);
      const top = Math.round((screen.height - h) / 2);
      const popupName = 'cth_memo_' + Date.now();
      window.open('', popupName,
        `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`);

      // 현재 페이지에 hidden form 생성 → target을 팝업으로 지정하여 POST
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = 'http://lolwiki.kr/freeboard/memo_read.php';
      form.target = popupName;
      form.style.display = 'none';
      const inpId = document.createElement('input');
      inpId.type = 'hidden'; inpId.name = 'android_id'; inpId.value = androidId;
      form.appendChild(inpId);
      const inpApp = document.createElement('input');
      inpApp.type = 'hidden'; inpApp.name = 'app_id'; inpApp.value = 'DEMACIA';
      form.appendChild(inpApp);
      document.body.appendChild(form);
      form.submit();
      form.remove();

      // 메뉴 닫기
      const menu = document.getElementById('lol_lpanel_userinfo_menu');
      if (menu) menu.style.display = 'none';
    });
  }

  /* ── 프로필 추적 기능 ── */
  function installProfileTracker() {
    let lastTrackedNick = '';

    function trackNick() {
      const nick = getMyNick();
      if (!nick || nick === lastTrackedNick) return;
      lastTrackedNick = nick;
      const url = location.origin;
      chrome.storage.local.get('cthProfiles', (data) => {
        const profiles = data.cthProfiles || {};
        profiles[nick] = {
          nick,
          url,
          lastSeen: Date.now()
        };
        chrome.storage.local.set({ cthProfiles: profiles });
      });
    }

    trackNick();
    setInterval(trackNick, 2000);

    // 팝업에서 현재 닉네임 조회
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'cth-get-nick') {
        sendResponse({ nick: getMyNick() });
        return;
      }
      if (msg.type === 'cth-get-lol-account') {
        sendResponse({
          nick: getMyNick(),
          android_id: document.documentElement.dataset.cthLolAndroidId || ''
        });
        return;
      }
      if (msg.type === 'cth-switch-account') {
        const targetNick = msg.nick;
        // page_bridge.js에 localStorage 교체 + 리로드 요청
        window.dispatchEvent(new CustomEvent('cth-switch-account', {
          detail: { nick: targetNick }
        }));
        sendResponse({ ok: true });
      }
      if (msg.type === 'cth-delete-profile') {
        chrome.storage.local.get('cthProfiles', (data) => {
          const profiles = data.cthProfiles || {};
          delete profiles[msg.nick];
          chrome.storage.local.set({ cthProfiles: profiles }, () => {
            sendResponse({ ok: true });
          });
        });
        return true; // async sendResponse
      }
    });
  }

  /* ── 라이브챗 차단 기능 ── */
  function applyLivechatBlock(blocked) {
    const box = document.getElementById('youtube_live_chat_box');
    const iframe = document.getElementById('youtube_live_chat_iframe');
    if (!box) return;
    if (blocked) {
      box.dataset.cthBlocked = '1';
      box.style.display = 'none';
      if (iframe && iframe.src) {
        iframe.dataset.cthOrigSrc = iframe.src;
        iframe.removeAttribute('src');
      }
    } else {
      if (box.dataset.cthBlocked) {
        delete box.dataset.cthBlocked;
        if (iframe && iframe.dataset.cthOrigSrc) {
          // 라이브 스트림이 차단된 상태였으면 display:block 으로 복원
          box.style.display = 'block';
          iframe.src = iframe.dataset.cthOrigSrc;
          delete iframe.dataset.cthOrigSrc;
        } else {
          // 라이브 스트림이 없었으면 인라인 스타일만 제거 (CSS 기본 none 유지)
          box.style.display = '';
        }
      }
    }
  }

  function installLivechatBlocker() {
    // 초기 상태 적용
    chrome.storage.local.get('cthBlockLivechat', (data) => {
      applyLivechatBlock(!!data.cthBlockLivechat);
    });

    // 옵션 변경 시 즉시 반영
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.cthBlockLivechat) {
        applyLivechatBlock(!!changes.cthBlockLivechat.newValue);
      }
    });

    // iframe src가 설정될 때 차단 상태면 즉시 제거
    const iframe = document.getElementById('youtube_live_chat_iframe');
    if (iframe) {
      const iframeObs = new MutationObserver(() => {
        chrome.storage.local.get('cthBlockLivechat', (data) => {
          if (data.cthBlockLivechat && iframe.src) {
            iframe.dataset.cthOrigSrc = iframe.src;
            iframe.removeAttribute('src');
            const box = document.getElementById('youtube_live_chat_box');
            if (box) {
              box.dataset.cthBlocked = '1';
              box.style.display = 'none';
            }
          }
        });
      });
      iframeObs.observe(iframe, { attributes: true, attributeFilter: ['src'] });
    }
  }

  /* ── 자유게시판 컴팩트(단일 컬럼) 모드 ──
     글 목록 / 글 내용 / 글쓰기를 왼쪽 485px 컬럼 하나로 합치고(목록 ⇄ 내용 전환),
     그만큼 오른쪽에 드러나는 공간으로 영상을 축소·이동시켜
     [자유게시판 | 영상 | 채팅]을 동시에 볼 수 있게 한다. */
  function installCompactBoard() {
    const panel = document.getElementById('lol_panel');
    if (!panel) return;
    const root = document.documentElement;
    let lastOpen = false;

    function isCompact() { return root.classList.contains('cth-compact'); }

    /* 목록 뷰 ⇄ 내용/글쓰기 뷰 전환 */
    function setView(view) {
      panel.classList.remove('cth-view-list', 'cth-view-detail', 'cth-view-write');
      panel.classList.add('cth-view-' + view);
    }
    /* 글쓰기·아이콘 제작 완료 후 목록으로 돌아갈 때 사용.
       완료 처리 과정에서 rpanel이 직전 글로 되돌아가며 제목이 바뀌는데,
       그 사이 동안은 '글이 열렸다'는 자동 전환을 막아 목록에 머무르게 한다. */
    let suppressAutoDetailUntil = 0;
    function backToList(ms) {
      suppressAutoDetailUntil = Date.now() + (ms || 3000);   // 서버 응답까지 넉넉히
      setView('list');
    }

    /* 영상 폭 계산에 쓰는 채팅창 실제 폭을 CSS 변수로 반영 */
    function updateVars() {
      const mc = document.getElementById('mainchat');
      const w = mc ? Math.round(mc.getBoundingClientRect().width) : 350;
      if (w > 0) root.style.setProperty('--cth-mainchat-w', w + 'px');
    }

    /* '← 목록' 버튼 생성 → 내용(rpanel) 오버레이에 주입.
       + 내용 뷰에서 우클릭 시 목록으로 복귀 (이미지/영상/링크/입력/텍스트선택 시엔 평소 우클릭 유지).
       닉네임 우클릭은 사이트가 '작성자 글 목록'을 로드하므로(결국 목록 표시) 함께 목록 뷰로 전환한다.
       글쓰기 뷰는 기존 '취소' 버튼이 목록 복귀를 담당하므로 별도 버튼 없음. */
    function ensureBackButton() {
      const rp = document.getElementById('lol_rpanel');
      const header = document.getElementById('lol_rpanel_header');
      if (!rp || !header || document.getElementById('cth-board-back-detail')) return;

      const b = document.createElement('div');
      b.id = 'cth-board-back-detail';
      b.textContent = '← 목록';
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setView('list');
      });
      header.appendChild(b);

      rp.addEventListener('contextmenu', (e) => {
        if (!isCompact() || !panel.classList.contains('cth-view-detail')) return;
        // 닉네임(#lol_rpanel_header_nick)은 제외하지 않음 → 우클릭 시 작성자 글 목록 로드 + 목록 뷰 전환
        if (e.target.closest('img, video, a, input, textarea')) return;
        if (window.getSelection && String(window.getSelection()).trim()) return; // 텍스트 선택 중
        e.preventDefault();
        setView('list');
      });

      /* rpanel에 글/스냅샷 내용이 실제로 로드되면(=제목 갱신) 목록 뷰에서 내용 뷰로 자동 전환.
         → 북마크/명예의전당 목록에서 글을 '우클릭'해 아카이브 스냅샷을 열 때도 정상 전환됨.
         일반 목록 우클릭은 rpanel 내용을 로드하지 않으므로 목록 뷰가 그대로 유지된다.
         단, 빈 상세(제목이 없거나 '글이 존재하지 않습니다.')로는 전환하지 않는다 —
         게시판을 처음 열 때 사이트가 빈 상세를 한 번 렌더해, 목록 대신 그 화면이 뜨는 문제 방지. */
      const title = document.getElementById('lol_rpanel_header_title');
      if (title) {
        new MutationObserver(() => {
          if (!isCompact() || !panel.classList.contains('cth-view-list')) return;
          // 글쓰기·아이콘 제작을 끝내고 방금 목록으로 돌아온 직후에는 무시한다.
          // (이때 rpanel이 직전에 보던 글로 되돌아가며 제목이 바뀌는데, 이를 '글 열림'으로
          //  오인해 목록 대신 그 글이 다시 뜨는 문제가 있었다)
          if (Date.now() < suppressAutoDetailUntil) return;
          const t = (title.textContent || '').trim();
          if (!t || t.indexOf('글이 존재하지 않습니다') !== -1) return;
          setView('detail');
        }).observe(title, { childList: true, characterData: true, subtree: true });
      }
    }

    /* 게시판 열림/닫힘 동기화 (열릴 때 목록 뷰로 초기화, 영상 축소 클래스 토글) */
    function syncOpenState() {
      const open = getComputedStyle(panel).display !== 'none';
      root.classList.toggle('cth-board-open', isCompact() && open);
      if (isCompact() && open) {
        updateVars();
        if (!lastOpen) setView('list');   // 새로 열렸을 때만 목록으로 리셋
      }
      lastOpen = open;
    }
    new MutationObserver(syncOpenState).observe(panel, {
      attributes: true, attributeFilter: ['style']
    });

    /* 글 목록에서 '좌클릭'으로 글을 열면 내용 보기로 전환 (목록은 동적 생성이라 위임 처리).
       우클릭은 목록에서 아무 동작도 하지 않아야 하므로 좌클릭만 훅에 건다. */
    const board = document.getElementById('lol_lpanel_board');
    if (board) {
      board.addEventListener('click', (e) => {
        if (isCompact() && e.target.closest('.lol_article_list_item')) setView('detail');
      }, true);
    }

    /* 진입/복귀 버튼 바인딩 (compact 상태일 때만 동작) */
    function bindClick(id, fn) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => { if (isCompact()) fn(); }, false);
    }
    bindClick('lol_lpanel_write_button', () => setView('write'));                        // 글쓰기
    bindClick('lol_lpanel_userinfo_menu_button_icon_change', () => setView('detail'));   // 아이콘 제작(내용 영역 사용)
    bindClick('lol_write_cancel', () => setView('list'));
    bindClick('lol_write_confirm', () => setTimeout(() => backToList(), 0));
    // 아이콘 '취소'는 사이트에서 선택한 이미지만 지우는 동작이므로 화면을 옮기지 않는다.
    // (목록으로 나가려면 '← 목록' 버튼이나 내용 영역 우클릭을 쓰면 된다)
    bindClick('lol_rpanel_body_icon_change_confirm', () => setTimeout(() => backToList(), 0));

    /* 옵션 적용/해제 */
    function apply(enabled) {
      root.classList.toggle('cth-compact', !!enabled);
      if (enabled) {
        ensureBackButton();
        updateVars();
        setView('list');
        syncOpenState();
      } else {
        panel.classList.remove('cth-view-list', 'cth-view-detail', 'cth-view-write');
        root.classList.remove('cth-board-open');
      }
    }

    chrome.storage.local.get('cthCompactBoard', (data) => apply(!!data.cthCompactBoard));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.cthCompactBoard) apply(!!changes.cthCompactBoard.newValue);
    });
    window.addEventListener('resize', () => {
      if (root.classList.contains('cth-board-open')) updateVars();
    });
  }

  boot();
})();
