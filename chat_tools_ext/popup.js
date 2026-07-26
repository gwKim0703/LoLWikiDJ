const blockCheckbox = document.getElementById('blockLivechat');

chrome.storage.local.get('cthBlockLivechat', (data) => {
  blockCheckbox.checked = !!data.cthBlockLivechat;
});

blockCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ cthBlockLivechat: blockCheckbox.checked });
});

/* ── 자유게시판 컴팩트 모드 ── */
const compactCheckbox = document.getElementById('compactBoard');

chrome.storage.local.get('cthCompactBoard', (data) => {
  compactCheckbox.checked = !!data.cthCompactBoard;
});

compactCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ cthCompactBoard: compactCheckbox.checked });
});

/* ── 새로고침·뒤로가기 이탈 확인창 ── */
const unloadGuardCheckbox = document.getElementById('unloadGuard');

chrome.storage.local.get('cthUnloadGuard', (data) => {
  unloadGuardCheckbox.checked = data.cthUnloadGuard !== false; // 기본 ON
});

unloadGuardCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ cthUnloadGuard: unloadGuardCheckbox.checked });
});

/* ── 프로필 목록 ── */
const profileListEl = document.getElementById('profileList');

function renderProfiles() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0] && tabs[0].id;
    if (!tabId) { renderProfileList('', {}); return; }
    chrome.tabs.sendMessage(tabId, { type: 'cth-get-nick' }, (resp) => {
      const currentNick = (resp && resp.nick) || '';
      chrome.storage.local.get('cthProfiles', (data) => {
        renderProfileList(currentNick, data.cthProfiles || {});
      });
    });
  });
}

function renderProfileList(currentNick, profiles) {
  const entries = Object.values(profiles).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  if (!entries.length) {
    profileListEl.innerHTML = '<div class="profile-empty">로그인 기록 없음</div>';
    return;
  }

  profileListEl.innerHTML = '';
  for (const p of entries) {
    const isActive = p.nick === currentNick;
    const item = document.createElement('div');
    item.className = 'profile-item' + (isActive ? ' active' : '');

    const nick = document.createElement('span');
    nick.className = 'profile-nick';
    nick.textContent = p.nick;
    item.appendChild(nick);

    const badge = document.createElement('span');
    badge.className = 'profile-badge';
    badge.textContent = '● 접속 중';
    item.appendChild(badge);

    const del = document.createElement('button');
    del.className = 'profile-delete';
    del.textContent = '✕';
    del.title = '프로필 삭제';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteProfile(p.nick);
    });
    item.appendChild(del);

    if (!isActive) {
      item.addEventListener('click', () => switchAccount(p.nick));
    }

    profileListEl.appendChild(item);
  }
}

function switchAccount(nick) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'cth-switch-account', nick }, () => {
      window.close();
    });
  });
}

function deleteProfile(nick) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'cth-delete-profile', nick }, () => {
      renderProfiles();
    });
  });
}

renderProfiles();
