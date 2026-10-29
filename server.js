const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

const state = { queue: [], current: null, playing: false, position: 0, updatedAt: Date.now() };
const users = new Map();

function snapshot() {
  return { ...state, serverNow: Date.now(), users: [...users.values()] };
}

function broadcast() {
  io.emit('state', snapshot());
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

io.on('connection', socket => {
  socket.emit('state', snapshot());

  socket.on('join', name => {
    users.set(socket.id, String(name || '익명').trim().slice(0, 20) || '익명');
    broadcast();
  });

  socket.on('add', async data => {
    const name = users.get(socket.id);
    if (!name || !data) return;
    const videoId = parseVideoId(data.url);
    if (!videoId) {
      socket.emit('toast', '유튜브 링크를 확인해주세요');
      return;
    }
    const title = (await fetchTitle(videoId)) || `YouTube 영상 (${videoId})`;
    const song = {
      id: crypto.randomUUID(),
      videoId,
      title,
      note: String(data.note || '').slice(0, 200),
      by: name,
      likes: [],
      addedAt: Date.now()
    };
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
    if (wasCurrent) selectIndex(i);
    broadcast();
  });

  socket.on('like', id => {
    const name = users.get(socket.id);
    const song = state.queue.find(s => s.id === id);
    if (!name || !song) return;
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

  socket.on('play', t => {
    if (!state.current) return;
    setPlayback(true, t);
    broadcast();
  });

  socket.on('pause', t => {
    if (!state.current) return;
    setPlayback(false, t);
    broadcast();
  });

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

  socket.on('disconnect', () => {
    users.delete(socket.id);
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`listening on ${PORT}`));
