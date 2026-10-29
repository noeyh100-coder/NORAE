const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 60000 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json([]);
  try {
    const videoId = parseVideoId(q);
    if (videoId) {
      const title = (await fetchTitle(videoId)) || `YouTube 영상 (${videoId})`;
      return res.json([{ videoId, title, channel: '', duration: '' }]);
    }
    res.json(process.env.YOUTUBE_API_KEY ? await searchApi(q) : await searchPage(q));
  } catch (e) {
    console.error('search failed:', e.message);
    res.status(502).json({ error: '검색에 실패했어요. 잠시 후 다시 시도해주세요' });
  }
});

const LEAVE_GRACE = 60 * 1000;
const CHAT_KEEP = 100;

const state = { queue: [], current: null, playing: false, position: 0, updatedAt: Date.now() };
// uid -> { name, sockets, timer } : 모바일에서 잠깐 나갔다 와도 바로 퇴장 처리하지 않음
const members = new Map();
// songId -> 추천한 사람 uid (uid는 클라이언트에 노출하지 않음)
const owners = new Map();
const chat = [];

function canControl(uid) {
  if (!state.current || !uid) return false;
  const owner = owners.get(state.current);
  // 추천한 사람이 방을 완전히 떠났으면 누구나 제어 가능
  return uid === owner || !members.has(owner);
}

function snapshot(socket) {
  return {
    ...state,
    serverNow: Date.now(),
    users: [...members.values()].map(m => m.name),
    canControl: canControl(socket.data.uid)
  };
}

function broadcast() {
  for (const s of io.sockets.sockets.values()) s.emit('state', snapshot(s));
}

function chatFor(m, uid) {
  return { id: m.id, name: m.name, text: m.text, at: m.at, mine: m.uid === uid };
}

function currentPos() {
  return state.playing ? state.position + (Date.now() - state.updatedAt) / 1000 : state.position;
}

function setPlayback(playing, position) {
  state.playing = playing;
  state.position = Math.max(0, Number(position) || 0);
  state.updatedAt = Date.now();
}

function selectIndex(i) {
  const song = state.queue[i];
  state.current = song ? song.id : null;
  setPlayback(!!song, 0);
}

function indexOfCurrent() {
  return state.queue.findIndex(s => s.id === state.current);
}

function attach(socket, uid, name) {
  detach(socket, true);
  let m = members.get(uid);
  if (!m) {
    m = { name, sockets: new Set(), timer: null };
    members.set(uid, m);
  }
  clearTimeout(m.timer);
  m.timer = null;
  m.name = name;
  m.sockets.add(socket.id);
  socket.data.uid = uid;
  socket.data.name = name;
}

function detach(socket, immediate) {
  const uid = socket.data.uid;
  const m = uid && members.get(uid);
  socket.data.uid = null;
  if (!m) return;
  m.sockets.delete(socket.id);
  if (m.sockets.size) return;
  if (immediate) {
    members.delete(uid);
    return;
  }
  m.timer = setTimeout(() => {
    if (m.sockets.size || members.get(uid) !== m) return;
    members.delete(uid);
    broadcast();
  }, LEAVE_GRACE);
}

function parseVideoId(input) {
  const text = String(input || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  const m = text.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

async function fetchTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch (e) {
    return null;
  }
}

// API 키 없이 유튜브 검색 결과 페이지의 ytInitialData를 읽어옴
async function searchPage(q) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%3D%3D&hl=ko&gl=KR`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Cookie: 'CONSENT=YES+1; SOCS=CAI'
    }
  });
  if (!res.ok) throw new Error(`youtube ${res.status}`);
  const html = await res.text();
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error('ytInitialData not found');
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object' || out.length >= 20) return;
    const v = o.videoRenderer;
    if (v && v.videoId) {
      out.push({
        videoId: v.videoId,
        title: (v.title && v.title.runs || []).map(r => r.text).join('') || v.videoId,
        channel: (v.ownerText && v.ownerText.runs || []).map(r => r.text).join(''),
        duration: (v.lengthText && v.lengthText.simpleText) || ''
      });
      return;
    }
    for (const k in o) walk(o[k]);
  })(JSON.parse(m[1]));
  return out;
}

// 환경변수 YOUTUBE_API_KEY가 있으면 공식 Data API 사용
async function searchApi(q) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=20&regionCode=KR&q=${encodeURIComponent(q)}&key=${process.env.YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`youtube api ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(it => ({
    videoId: it.id.videoId,
    title: it.snippet.title,
    channel: it.snippet.channelTitle,
    duration: ''
  }));
}

io.on('connection', socket => {
  socket.emit('state', snapshot(socket));

  socket.on('join', data => {
    const name = String((data && data.name) || '익명').trim().slice(0, 20) || '익명';
    const uid = String((data && data.uid) || '').slice(0, 64) || socket.id;
    attach(socket, uid, name);
    socket.emit('chatHistory', chat.map(m => chatFor(m, uid)));
    broadcast();
  });

  socket.on('add', async data => {
    const name = socket.data.name;
    const uid = socket.data.uid;
    if (!uid || !data) return;
    const videoId = parseVideoId(data.videoId);
    if (!videoId) {
      socket.emit('toast', '영상을 찾을 수 없어요');
      return;
    }
    const title = (await fetchTitle(videoId)) || String(data.title || '').slice(0, 200) || `YouTube 영상 (${videoId})`;
    const song = {
      id: crypto.randomUUID(),
      videoId,
      title,
      note: String(data.note || '').slice(0, 200),
      by: name,
      likes: [],
      addedAt: Date.now()
    };
    owners.set(song.id, uid);
    state.queue.push(song);
    if (!state.current) selectIndex(state.queue.length - 1);
    broadcast();
    io.emit('toast', `${name}님이 「${title}」를 추천했어요`);
  });

  socket.on('remove', id => {
    const i = state.queue.findIndex(s => s.id === id);
    if (i < 0) return;
    const wasCurrent = state.current === id;
    state.queue.splice(i, 1);
    owners.delete(id);
    if (wasCurrent) selectIndex(i);
    broadcast();
  });

  socket.on('like', id => {
    const name = socket.data.name;
    const song = state.queue.find(s => s.id === id);
    if (!socket.data.uid || !song) return;
    const k = song.likes.indexOf(name);
    if (k < 0) song.likes.push(name);
    else song.likes.splice(k, 1);
    broadcast();
  });

  socket.on('select', id => {
    const i = state.queue.findIndex(s => s.id === id);
    if (i < 0) return;
    selectIndex(i);
    broadcast();
  });

  function control(playing, t) {
    if (!state.current) return;
    if (!canControl(socket.data.uid)) {
      socket.emit('toast', '일시정지는 곡을 추천한 사람만 할 수 있어요');
      socket.emit('state', snapshot(socket));
      return;
    }
    setPlayback(playing, t);
    broadcast();
  }

  socket.on('play', t => control(true, t));
  socket.on('pause', t => control(false, t));

  socket.on('seek', t => {
    if (!state.current) return;
    setPlayback(state.playing, t);
    broadcast();
  });

  socket.on('next', () => {
    const i = indexOfCurrent();
    if (i + 1 >= state.queue.length) return;
    selectIndex(i + 1);
    broadcast();
  });

  socket.on('prev', () => {
    const i = indexOfCurrent();
    if (i <= 0) return;
    selectIndex(i - 1);
    broadcast();
  });

  socket.on('ended', id => {
    if (id !== state.current) return;
    const i = indexOfCurrent();
    if (i + 1 < state.queue.length) selectIndex(i + 1);
    else setPlayback(false, currentPos());
    broadcast();
  });

  socket.on('chat', text => {
    if (!socket.data.uid) return;
    const msg = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const now = Date.now();
    if (!msg || now - (socket.data.lastChat || 0) < 400) return;
    socket.data.lastChat = now;
    const m = { id: crypto.randomUUID(), uid: socket.data.uid, name: socket.data.name, text: msg, at: now };
    chat.push(m);
    if (chat.length > CHAT_KEEP) chat.shift();
    for (const s of io.sockets.sockets.values()) {
      if (s.data.uid) s.emit('chat', chatFor(m, s.data.uid));
    }
  });

  socket.on('disconnect', () => {
    detach(socket, false);
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`listening on ${PORT}`));
