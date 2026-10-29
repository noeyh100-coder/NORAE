const socket = io();
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let st = null;
let offset = 0;
let player = null;
let ready = false;
let joined = false;
let me = null;
let loadedId = null;
let suppressUntil = 0;
let lastT = 0;
let lastTick = Date.now();
let toastTimer = null;
let visChangedAt = 0;
let tab = 'chat';
let unread = 0;
let danmakuOn = true;
let keepAlive = null;
let wakeLock = null;
let wakeLockPending = false;
let metaId = null;
const lanes = [];

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// 새로고침해도 같은 사람으로 인식되도록 기기별 고유 id 유지 (추천자 권한 판별용)
const uid = (() => {
  let id = null;
  try {
    id = localStorage.getItem('uid');
  } catch (e) {}
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    try {
      localStorage.setItem('uid', id);
    } catch (e) {}
  }
  return id;
})();

function serverNow() {
  return Date.now() + offset;
}

function expected() {
  if (!st) return 0;
  return st.playing ? st.position + (serverNow() - st.updatedAt) / 1000 : st.position;
}

function currentSong() {
  return st ? st.queue.find(s => s.id === st.current) : null;
}

function hold(ms) {
  suppressUntil = Date.now() + (ms || 1500);
}

// 백그라운드 전환 직후 브라우저가 멈춘 것을 사용자가 멈춘 것으로 오인하지 않도록
function backgrounded() {
  return document.hidden || Date.now() - visChangedAt < 1500;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player('player', {
    width: '100%',
    height: '100%',
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => {
        ready = true;
        sync();
      },
      onStateChange: onPlayerState
    }
  });
};

function onPlayerState(e) {
  if (!st || !st.current || loadedId !== st.current || !joined) return;
  if (e.data === YT.PlayerState.ENDED) {
    socket.emit('ended', st.current);
    return;
  }
  if (Date.now() < suppressUntil || backgrounded()) return;
  const t = player.getCurrentTime();
  if (e.data === YT.PlayerState.PLAYING) {
    if (!st.playing) socket.emit('play', t);
    else if (Math.abs(t - expected()) > 1.5) socket.emit('seek', t);
  } else if (e.data === YT.PlayerState.PAUSED && st.playing) {
    // 권한이 없으면 서버가 거절하고, 아래 sync 루프가 다시 재생시킴
    socket.emit('pause', t);
  }
}

function sync() {
  if (!ready || !joined || !st) return;
  const song = currentSong();
  if (!song) {
    if (loadedId) {
      player.stopVideo();
      loadedId = null;
    }
    return;
  }
  const target = expected();
  if (loadedId !== song.id) {
    loadedId = song.id;
    hold(2500);
    if (st.playing) player.loadVideoById({ videoId: song.videoId, startSeconds: target });
    else player.cueVideoById({ videoId: song.videoId, startSeconds: target });
    return;
  }
  const ps = player.getPlayerState();
  const t = player.getCurrentTime();
  if (st.playing) {
    if (ps === 0 && target >= player.getDuration() - 1) return;
    if (ps !== 1 && ps !== 3) {
      hold();
      player.seekTo(target, true);
      player.playVideo();
    } else if (Math.abs(t - target) > 1.5) {
      hold();
      player.seekTo(target, true);
    }
  } else {
    if (ps === 1 || ps === 3) {
      hold();
      if (Math.abs(t - target) > 1.5) player.seekTo(target, true);
      player.pauseVideo();
    } else if (ps === 2 && Math.abs(t - target) > 1.5) {
      hold();
      player.seekTo(target, true);
    }
  }
}

setInterval(() => {
  if (!ready || !joined || !st || !st.current || loadedId !== st.current) return;
  const now = Date.now();
  const t = player.getCurrentTime();
  const ps = player.getPlayerState();
  const predicted = lastT + (ps === 1 ? (now - lastTick) / 1000 : 0);
  const jumped = Math.abs(t - predicted) > 1.5;
  lastT = t;
  lastTick = now;
  if (now < suppressUntil) return;
  if (jumped && !backgrounded() && Math.abs(t - expected()) > 1.5) {
    hold();
    socket.emit('seek', t);
    return;
  }
  sync();
}, 500);

/* ---------- 백그라운드 재생 / 화면 꺼짐 방지 ---------- */

// 무음 오디오를 계속 틀어두면 안드로이드에서 페이지가 '재생 중'으로 유지되고 잠금화면 컨트롤이 생김
function silentWavUrl() {
  const rate = 8000;
  const n = rate * 10;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  w(36, 'data');
  v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function startKeepAlive() {
  if (isIOS || keepAlive) return;
  keepAlive = new Audio(silentWavUrl());
  keepAlive.loop = true;
  keepAlive.play().catch(() => {});
}

function resumeIfNeeded() {
  if (!ready || !joined || !st || !st.playing || loadedId !== st.current) return;
  const ps = player.getPlayerState();
  if (ps !== 1 && ps !== 3) {
    hold();
    player.playVideo();
  }
  if (keepAlive && keepAlive.paused) keepAlive.play().catch(() => {});
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const on = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch (e) {}
  };
  on('play', () => {
    if (!st || !st.current) return;
    if (st.playing) resumeIfNeeded();
    else socket.emit('play', expected());
  });
  on('pause', () => {
    if (st && st.playing && st.canControl) socket.emit('pause', ready ? player.getCurrentTime() : expected());
  });
  on('nexttrack', () => socket.emit('next'));
  on('previoustrack', () => socket.emit('prev'));
}

function updateMedia() {
  const song = currentSong();
  if (keepAlive) {
    if (st && st.playing) keepAlive.play().catch(() => {});
    else keepAlive.pause();
  }
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = song ? (st.playing ? 'playing' : 'paused') : 'none';
  if (!song || song.id === metaId || typeof MediaMetadata === 'undefined') return;
  metaId = song.id;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: `추천 · ${song.by}`,
    album: '같이 듣기',
    artwork: [{ src: `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }]
  });
}

async function updateWakeLock() {
  if (!('wakeLock' in navigator) || wakeLockPending) return;
  const want = joined && !document.hidden && !!st && st.playing;
  if (want && !wakeLock) {
    wakeLockPending = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch (e) {}
    wakeLockPending = false;
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  visChangedAt = Date.now();
  if (document.hidden) {
    // 앱 전환/화면 잠금 시 브라우저가 영상을 멈추면 다시 재생 시도
    setTimeout(resumeIfNeeded, 400);
    setTimeout(resumeIfNeeded, 1500);
    setTimeout(resumeIfNeeded, 4000);
  } else {
    if (!socket.connected) socket.connect();
    lastTick = Date.now();
    lastT = ready ? player.getCurrentTime() : 0;
    sync();
  }
  updateWakeLock();
});

window.addEventListener('pageshow', e => {
  if (e.persisted && !socket.connected) socket.connect();
});

/* ---------- 화면 채팅 (흘러가는 채팅) ---------- */

function fly(m) {
  const box = $('#danmaku');
  const W = box.clientWidth;
  const H = box.clientHeight;
  if (!W || !H || document.hidden) return;
  const size = Math.round(Math.max(14, Math.min(30, H / 11)));
  const lineH = Math.round(size * 1.4);
  const count = Math.max(1, Math.floor((H * 0.85) / lineH));
  const el = document.createElement('div');
  el.className = 'dm' + (m.mine ? ' mine' : '');
  el.textContent = m.text;
  el.style.fontSize = size + 'px';
  el.style.transform = `translateX(${W}px)`;
  box.appendChild(el);
  const w = el.offsetWidth;
  const speed = Math.max(90, W / 5);
  const now = performance.now();
  let lane = -1;
  let best = 0;
  for (let i = 0; i < count; i++) {
    const free = lanes[i] || 0;
    if (free <= now) {
      lane = i;
      break;
    }
    if (lane < 0 || free < best) {
      lane = i;
      best = free;
    }
  }
  lanes[lane] = now + ((w + 30) / speed) * 1000;
  el.style.top = Math.round(H * 0.02) + lane * lineH + 'px';
  const anim = el.animate(
    [{ transform: `translateX(${W}px)` }, { transform: `translateX(${-w}px)` }],
    { duration: ((W + w) / speed) * 1000, easing: 'linear' }
  );
  anim.onfinish = () => el.remove();
}

function addChat(m, live) {
  const log = $('#chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const li = document.createElement('li');
  li.className = 'chat-msg' + (m.mine ? ' mine' : '');
  li.innerHTML = `<b>${esc(m.name)}</b><span>${esc(m.text)}</span>`;
  log.appendChild(li);
  while (log.children.length > 200) log.firstChild.remove();
  if (atBottom || m.mine) log.scrollTop = log.scrollHeight;
  if (!live) return;
  if (danmakuOn) fly(m);
  if (tab !== 'chat') {
    unread++;
    renderUnread();
  }
}

function renderUnread() {
  $('#unread').textContent = unread ? (unread > 99 ? '99+' : unread) : '';
}

function setTab(t) {
  tab = t;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === t));
  if (t === 'chat') {
    unread = 0;
    renderUnread();
    $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  }
}

function setDanmaku(on) {
  danmakuOn = on;
  $('#dmBtn').classList.toggle('off', !on);
  if (!on) $('#danmaku').innerHTML = '';
  try {
    localStorage.setItem('danmaku', on ? '1' : '0');
  } catch (e) {}
}

/* ---------- 렌더링 ---------- */

function render() {
  $('#users').innerHTML = st.users.map(u => `<span class="user">${esc(u)}</span>`).join('');
  $('#count').textContent = st.queue.length ? `(${st.queue.length})` : '';

  const song = currentSong();
  $('#empty').classList.toggle('hidden', !!song);
  $('#nowTitle').textContent = song ? song.title : '-';
  $('#nowMeta').textContent = song ? `추천 · ${song.by}${song.likes.length ? ` · ♥ ${song.likes.length}` : ''}` : '';
  $('#nowNote').textContent = song && song.note ? `💬 ${song.note}` : '';

  const playBtn = $('#playBtn');
  playBtn.textContent = st.playing ? '⏸' : '▶';
  playBtn.classList.toggle('locked', !st.canControl);
  playBtn.title = st.canControl ? '재생/일시정지' : '곡을 추천한 사람만 일시정지할 수 있어요';

  updateMedia();
  updateWakeLock();

  if (!st.queue.length) {
    $('#queue').innerHTML = '<li class="empty-list">추천된 곡이 없어요</li>';
    return;
  }
  $('#queue').innerHTML = st.queue.map(s => `
    <li class="song ${s.id === st.current ? 'active' : ''}" data-id="${s.id}">
      <img src="https://i.ytimg.com/vi/${s.videoId}/mqdefault.jpg" alt="">
      <div class="info">
        <div class="title">${esc(s.title)}</div>
        <div class="meta">추천 · ${esc(s.by)}</div>
      </div>
      <div class="actions">
        <button data-act="like" class="${s.likes.includes(me) ? 'liked' : ''}" title="${esc(s.likes.join(', '))}">♥ ${s.likes.length}</button>
        <button data-act="remove" title="삭제">✕</button>
      </div>
    </li>`).join('');
}

socket.on('state', s => {
  st = s;
  offset = s.serverNow - Date.now();
  render();
  sync();
});

socket.on('toast', toast);

socket.on('chatHistory', list => {
  $('#chatLog').innerHTML = '';
  list.forEach(m => addChat(m, false));
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
});

socket.on('chat', m => addChat(m, true));

socket.on('connect', () => {
  if (me) socket.emit('join', { name: me, uid });
});

/* ---------- 이벤트 ---------- */

$('#queue').addEventListener('click', e => {
  const li = e.target.closest('.song');
  if (!li) return;
  const btn = e.target.closest('button');
  if (btn) socket.emit(btn.dataset.act, li.dataset.id);
  else socket.emit('select', li.dataset.id);
});

let results = [];

$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (!q) return;
  $('#searchInput').blur();
  $('#searchBtn').disabled = true;
  $('#results').hidden = false;
  $('#resultList').innerHTML = '<li class="empty-list">검색 중…</li>';
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    results = data;
    $('#resultList').innerHTML = results.length
      ? results.map((r, i) => `
        <li class="song result" data-i="${i}">
          <div class="thumb">
            <img src="https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg" alt="" loading="lazy">
            ${r.duration ? `<span class="duration">${esc(r.duration)}</span>` : ''}
          </div>
          <div class="info">
            <div class="title">${esc(r.title)}</div>
            <div class="meta">${esc(r.channel)}</div>
          </div>
          <div class="actions">
            <button class="pick" data-act="pick">추천</button>
          </div>
        </li>`).join('')
      : '<li class="empty-list">검색 결과가 없어요</li>';
  } catch (err) {
    $('#resultList').innerHTML = `<li class="empty-list">${esc(err.message || '검색에 실패했어요')}</li>`;
  }
  $('#searchBtn').disabled = false;
});

$('#resultList').addEventListener('click', e => {
  const btn = e.target.closest('button.pick');
  if (!btn) return;
  const r = results[btn.closest('.result').dataset.i];
  if (!r) return;
  socket.emit('add', { videoId: r.videoId, title: r.title, note: $('#noteInput').value });
  $('#noteInput').value = '';
  btn.textContent = '추천됨';
  btn.disabled = true;
});

$('#closeResults').addEventListener('click', () => {
  $('#results').hidden = true;
  $('#resultList').innerHTML = '';
  $('#searchInput').value = '';
});

$('#chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  socket.emit('chat', text);
  $('#chatInput').value = '';
});

$$('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

$('#prevBtn').addEventListener('click', () => socket.emit('prev'));
$('#nextBtn').addEventListener('click', () => socket.emit('next'));

$('#playBtn').addEventListener('click', () => {
  if (!st || !st.current) return;
  if (!st.canControl) {
    toast('일시정지는 곡을 추천한 사람만 할 수 있어요');
    return;
  }
  const t = ready ? player.getCurrentTime() : expected();
  if (st.playing) {
    socket.emit('pause', t);
  } else {
    socket.emit('play', t);
    // 모바일 자동재생 제한을 피하려고 사용자 터치 안에서 바로 재생
    if (ready) {
      hold();
      player.playVideo();
    }
  }
});

$('#dmBtn').addEventListener('click', () => setDanmaku(!danmakuOn));

const playerWrap = $('#playerWrap');
if (!(document.fullscreenEnabled || document.webkitFullscreenEnabled)) $('#fsBtn').hidden = true;
$('#fsBtn').addEventListener('click', async () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  try {
    await (playerWrap.requestFullscreen ? playerWrap.requestFullscreen() : playerWrap.webkitRequestFullscreen());
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch (e) {}
});

/* ---------- 모바일 확대 방지 ---------- */

document.addEventListener('gesturestart', e => e.preventDefault());

/* ---------- 입장 ---------- */

try {
  $('#nameInput').value = localStorage.getItem('nickname') || '';
  if ($('#nameInput').value) $('#joinBtn').textContent = '이어 듣기';
  setDanmaku(localStorage.getItem('danmaku') !== '0');
} catch (e) {}

setupMediaSession();

$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  me = $('#nameInput').value.trim().slice(0, 20);
  if (!me) return;
  try {
    localStorage.setItem('nickname', me);
  } catch (err) {}
  joined = true;
  socket.emit('join', { name: me, uid });
  $('#join').classList.add('hidden');
  startKeepAlive();
  sync();
  updateWakeLock();
});
