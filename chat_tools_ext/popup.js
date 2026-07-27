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

/* ── 버전 표시 / 업데이트 ──
   크롬은 웹스토어 설치본에만 manifest 에 update_url 을 넣어 준다.
   개발자 모드(압축 해제) 설치본은 크롬이 갱신해 주지 않으므로 requestUpdateCheck 도 쓸 수 없다. */
const manifest = chrome.runtime.getManifest();
const fromStore = !!manifest.update_url;
const verText = document.getElementById('verText');
const verSrc = document.getElementById('verSrc');
const verNote = document.getElementById('verNote');
const updateBtn = document.getElementById('updateBtn');

verText.textContent = 'v' + manifest.version;
verSrc.textContent = fromStore ? '· 웹스토어' : '· 개발자 모드';

function setNote(text, tone) {
  verNote.textContent = text || '';
  verNote.className = 'ver-note' + (tone ? ' ' + tone : '');
  verNote.style.display = text ? 'block' : 'none';
}

// 내려받아 둔 새 버전이 있을 때: 버튼을 '지금 적용'으로 바꾼다
function offerApply(version) {
  setNote('새 버전 ' + (version ? 'v' + version + ' ' : '') + '이(가) 준비됐습니다.', 'good');
  updateBtn.textContent = '지금 적용';
  updateBtn.classList.add('apply');
  updateBtn.disabled = false;
  updateBtn.onclick = applyUpdate;
}

// chrome.runtime.reload() 가 대기 중인 새 버전을 적용한다.
// 이때 열려 있던 탭의 content script 는 끊기므로, 보고 있던 롤디 탭은 먼저 새로고침시킨다.
function applyUpdate() {
  updateBtn.disabled = true;
  setNote('적용 중…');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs && tabs[0] && tabs[0].id;
    const reloadExt = () => chrome.runtime.reload();
    if (tabId == null) { reloadExt(); return; }
    chrome.tabs.sendMessage(tabId, { type: 'cth-reload-page' }, () => {
      void chrome.runtime.lastError;          // 롤디 탭이 아니면 응답이 없다 — 그대로 진행
      setTimeout(reloadExt, 300);             // 새로고침이 시작될 틈을 준 뒤 확장 재시작
    });
  });
}

async function checkUpdate() {
  updateBtn.disabled = true;
  setNote('확인 중…');
  try {
    // MV3 는 프로미스로 {status, version} 을 준다. 콜백 형태(status, details)도 대비해 둔다.
    const res = await chrome.runtime.requestUpdateCheck();
    const status = res && (res.status || res[0]);
    const version = (res && (res.version || (res[1] && res[1].version))) || '';
    if (status === 'update_available') { offerApply(version); return; }
    if (status === 'throttled') setNote('확인 요청이 잦아 잠시 막혔습니다. 조금 뒤에 다시 눌러 주세요.');
    else setNote('최신 버전입니다.', 'good');
  } catch (e) {
    setNote('업데이트를 확인할 수 없습니다.\n' + ((e && e.message) || e), 'warn');
  }
  updateBtn.disabled = false;
}

if (fromStore) {
  updateBtn.onclick = checkUpdate;
  // 크롬이 이미 새 버전을 내려받아 뒀다면(백그라운드 onUpdateAvailable) 바로 '지금 적용'으로
  chrome.storage.local.get('cthPendingUpdate', (d) => {
    const pending = d && d.cthPendingUpdate;
    if (pending && pending.version !== manifest.version) offerApply(pending.version);
  });
} else {
  updateBtn.style.display = 'none';
  setNote('압축을 풀어 직접 로드한 설치본이라 크롬이 자동으로 갱신하지 않습니다.\n'
    + '새 ZIP 을 받아 같은 폴더에 덮어쓴 뒤, chrome://extensions 에서 새로고침(⟳)해 주세요.', 'warn');
}
