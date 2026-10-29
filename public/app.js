const socket = io();
const $ = s => document.querySelector(s);

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
  if (Date.now() < suppressUntil) return;
  const t = player.getCurrentTime();
  if (e.data === YT.PlayerState.PLAYING) {
    if (!st.playing) socket.emit('play', t);
    else if (Math.abs(t - expected()) > 1.5) socket.emit('seek', t);
  } else if (e.data === YT.PlayerState.PAUSED && st.playing) {
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
  if (jumped && Math.abs(t - expected()) > 1.5) {
    hold();
    socket.emit('seek', t);
    return;
  }
  sync();
}, 500);

function render() {
  $('#users').innerHTML = st.users.map(u => `<span class="user">${esc(u)}</span>`).join('');
  $('#count').textContent = st.queue.length ? `(${st.queue.length})` : '';

  const song = currentSong();
  $('#empty').classList.toggle('hidden', !!song);
  $('#nowTitle').textContent = song ? song.title : '-';
  $('#nowMeta').textContent = song ? `추천 · ${song.by}${song.likes.length ? ` · ♥ ${song.likes.length}` : ''}` : '';
  $('#nowNote').textContent = song && song.note ? `💬 ${song.note}` : '';

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

socket.on('connect', () => {
  if (me) socket.emit('join', me);
});

$('#queue').addEventListener('click', e => {
  const li = e.target.closest('.song');
  if (!li) return;
  const btn = e.target.closest('button');
  if (btn) socket.emit(btn.dataset.act, li.dataset.id);
  else socket.emit('select', li.dataset.id);
});

$('#addForm').addEventListener('submit', e => {
  e.preventDefault();
  socket.emit('add', { url: $('#urlInput').value, note: $('#noteInput').value });
  $('#urlInput').value = '';
  $('#noteInput').value = '';
});

$('#prevBtn').addEventListener('click', () => socket.emit('prev'));
$('#nextBtn').addEventListener('click', () => socket.emit('next'));

try {
  $('#nameInput').value = localStorage.getItem('nickname') || '';
} catch (e) {}

$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  me = $('#nameInput').value.trim().slice(0, 20);
  if (!me) return;
  try {
    localStorage.setItem('nickname', me);
  } catch (err) {}
  joined = true;
  socket.emit('join', me);
  $('#join').classList.add('hidden');
  sync();
});
