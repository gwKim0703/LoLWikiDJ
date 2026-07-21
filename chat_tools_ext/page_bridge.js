/* page_bridge.js — 페이지 컨텍스트(world: MAIN)에서 실행됨 */
(function () {
  'use strict';

  /* content script → page: 알림 소리 재생 요청 */
  window.addEventListener('cth-play-reply-sound', function () {
    try {
      if (typeof play_call_audio === 'function') {
        play_call_audio();
      } else {
        var audioEl = document.getElementById('audio_chat_call');
        if (audioEl) {
          var volSlider = document.getElementById('option_slider_mention_volume');
          if (volSlider) audioEl.volume = volSlider.value;
          audioEl.pause();
          audioEl.currentTime = 0;
          audioEl.play();
        }
      }
    } catch (e) {}
  });

  /* 주기적으로 g_nick을 DOM dataset에 동기화 */
  function syncNick() {
    document.documentElement.dataset.cthMyNick =
      (typeof g_nick !== 'undefined' && g_nick) ? g_nick : '';
  }
  syncNick();
  setInterval(syncNick, 1500);

  /* 주기적으로 g_lol_android_id를 DOM dataset에 동기화 */
  function syncLolAccount() {
    document.documentElement.dataset.cthLolAndroidId =
      (typeof g_lol_android_id !== 'undefined' && g_lol_android_id) ? g_lol_android_id : '';
  }
  syncLolAccount();
  setInterval(syncLolAccount, 1500);

  /* 계정 전환 요청 수신 (content.js → page context) */
  window.addEventListener('cth-switch-account', function (e) {
    var nick = e.detail && e.detail.nick;
    if (!nick) return;
    var key = (typeof g_storage_nick_key !== 'undefined' && g_storage_nick_key)
      ? g_storage_nick_key : 'LoLWikiDJ';
    if (localStorage.getItem(key) !== null) {
      // 자동 로그인 ON: 닉네임 교체 후 리로드
      localStorage.setItem(key, nick);
    } else {
      // 자동 로그인 OFF: 일회성 전환 플래그 저장
      sessionStorage.setItem('cth_switch_nick', nick);
    }
    location.reload();
  });

  /* 페이지 로드 시 일회성 전환 닉네임이 있으면 자동 입력 후 로그인 */
  var switchNick = sessionStorage.getItem('cth_switch_nick');
  if (switchNick) {
    sessionStorage.removeItem('cth_switch_nick');
    function trySwitchLogin() {
      var loginInput = document.getElementById('login_id');
      if (!loginInput || typeof login !== 'function') return false;
      if (typeof socket === 'undefined' || !socket || !socket.connected) return false;
      if (typeof g_player_ready !== 'undefined' && !g_player_ready) return false;
      loginInput.value = switchNick;
      login();
      return true;
    }
    // socket 연결 + player 준비를 기다려야 하므로 반복 시도
    if (!trySwitchLogin()) {
      var switchTimer = setInterval(function () {
        if (trySwitchLogin()) clearInterval(switchTimer);
      }, 300);
      setTimeout(function () { clearInterval(switchTimer); }, 15000);
    }
  }

  /* 볼륨 복원 요청 수신 (content.js → page context) */
  window.addEventListener('cth-restore-volume', function (e) {
    var vol = e.detail && e.detail.volume;
    var muted = e.detail && e.detail.muted;
    function apply() {
      if (typeof player === 'undefined' || !player || !player.setVolume) return false;
      if (typeof vol === 'number') {
        player.setVolume(vol);
        var m3u8 = document.getElementById('m3u8_player');
        var flv = document.getElementById('flv_player');
        if (m3u8) m3u8.volume = vol / 100;
        if (flv) flv.volume = vol / 100;
        var slider = document.getElementById('video_info_volume_slider');
        if (slider) slider.value = vol;
      }
      if (muted) {
        player.mute();
        var m3u8 = document.getElementById('m3u8_player');
        var flv = document.getElementById('flv_player');
        if (m3u8) m3u8.muted = true;
        if (flv) flv.muted = true;
      } else if (muted === false) {
        player.unMute();
        var m3u8 = document.getElementById('m3u8_player');
        var flv = document.getElementById('flv_player');
        if (m3u8) m3u8.muted = false;
        if (flv) flv.muted = false;
      }
      return true;
    }
    // player가 아직 초기화되지 않았을 수 있으므로 반복 시도
    if (!apply()) {
      var tries = 0;
      var timer = setInterval(function () {
        if (apply() || ++tries > 50) clearInterval(timer);
      }, 200);
    }
  });
})();
