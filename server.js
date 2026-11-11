'use strict';
/**
 * Tactical Comms - room server
 *
 *   npm install && npm start        (PORT env var optional, default 3000)
 *
 * Serves public/index.html over HTTP and runs a WebSocket endpoint on the same port.
 *
 * Protocol (JSON text frames)
 *   client -> server
 *     {t:'join',   token, room, name}
 *     {t:'leave'}
 *     {t:'rename', name}
 *     {t:'select', target}              target = user id or null
 *     {t:'interact', target, action}    action = SQUEEZE | HARD SQUEEZE | TAP
 *     {t:'ping'}
 *   server -> client
 *     {t:'joined', you:{id,name}, room, users:[{id,name,selected}], renamed}
 *     {t:'users', users:[...]}          full roster, sent on every presence/selection change
 *     {t:'interaction', from:{id,name}, action}
 *     {t:'ack', to:{id,name}, action}
 *     {t:'renamed', you:{id,name}, renamed}
 *     {t:'left'}
 *     {t:'error', code, msg}
 *     {t:'pong'}
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOM_SIZE = 16;
const MAX_NAME = 20;
const ACTIONS = new Set(['SQUEEZE', 'HARD SQUEEZE', 'TAP']);
const ROOM_RE = /^[A-Z0-9_-]{1,32}$/;
// index.html may live in ./public/ (preferred) or right next to server.js
const INDEX_CANDIDATES = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html'),
  path.join(process.cwd(), 'public', 'index.html'),
  path.join(process.cwd(), 'index.html'),
];

function readIndex(cb, i = 0) {
  if (i >= INDEX_CANDIDATES.length) return cb(new Error('not found'));
  fs.readFile(INDEX_CANDIDATES[i], (err, data) => (err ? readIndex(cb, i + 1) : cb(null, data)));
}

/** ROOM -> Map<publicId, ws>. A ws in a room always has ws.user set. */
const rooms = new Map();

// ------------------------------------------------------------------ http
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  if (url === '/' || url === '/index.html') {
    readIndex((err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html missing. Put it in a "public" folder next to server.js, or beside server.js itself.\nLooked in:\n' + INDEX_CANDIDATES.join('\n'));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

// ------------------------------------------------------------------ helpers
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function err(ws, code, msg) {
  send(ws, { t: 'error', code, msg });
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function roster(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) return [];
  return [...room.values()].map((w) => ({ id: w.user.id, name: w.user.name, selected: w.user.selected }));
}

function broadcastRoster(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) return;
  const msg = { t: 'users', users: roster(roomKey) };
  for (const w of room.values()) send(w, msg);
}

/** Case-insensitive unique display name inside a room: "Bob", "Bob (2)", ... */
function uniqueName(roomKey, wanted, selfId) {
  const taken = new Set();
  const room = rooms.get(roomKey);
  if (room) for (const w of room.values()) if (w.user.id !== selfId) taken.add(w.user.name.toLowerCase());
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let i = 2; i < 1000; i++) {
    const suffix = ` (${i})`;
    const cand = wanted.slice(0, MAX_NAME - suffix.length) + suffix;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return wanted.slice(0, MAX_NAME - 5) + ' (' + crypto.randomInt(1000, 9999) + ')';
}

/** Remove a socket from its room, clear selections that pointed at it, tell the room. */
function leaveRoom(ws) {
  const u = ws.user;
  if (!u) return;
  ws.user = null;
  const room = rooms.get(u.room);
  if (!room) return;
  if (room.get(u.id) === ws) room.delete(u.id);
  if (room.size === 0) {
    rooms.delete(u.room);
    return;
  }
  for (const w of room.values()) if (w.user.selected === u.id) w.user.selected = null;
  broadcastRoster(u.room);
}

// ------------------------------------------------------------------ handlers
function handleJoin(ws, m) {
  const name = cleanName(m.name);
  const roomKey = typeof m.room === 'string' ? m.room.trim().toUpperCase() : '';
  const token = typeof m.token === 'string' && m.token.length >= 8 && m.token.length <= 64 ? m.token : null;

  if (!name) return err(ws, 'NAME_INVALID', 'Enter a display name (1-20 characters).');
  if (!ROOM_RE.test(roomKey)) return err(ws, 'ROOM_INVALID', 'Room ID: 1-32 letters, numbers, - or _.');
  if (!token) return err(ws, 'TOKEN_INVALID', 'Bad session token.');

  if (ws.user) leaveRoom(ws); // switching rooms / re-joining on the same socket

  // Same client reconnecting after a drop: evict its stale socket so it doesn't ghost in the list.
  const existing = rooms.get(roomKey);
  if (existing) {
    for (const other of [...existing.values()]) {
      if (other !== ws && other.user.token === token) {
        existing.delete(other.user.id);
        other.user = null;
        other.close(4000, 'replaced');
      }
    }
  }

  const room = rooms.get(roomKey) || new Map();
  if (room.size >= MAX_ROOM_SIZE) {
    if (room.size === 0) rooms.delete(roomKey);
    return err(ws, 'ROOM_FULL', `Room is full (${MAX_ROOM_SIZE} max).`);
  }
  rooms.set(roomKey, room);

  const id = crypto.randomBytes(5).toString('hex');
  const finalName = uniqueName(roomKey, name, id);
  ws.user = { id, token, name: finalName, room: roomKey, selected: null, hits: [] };
  room.set(id, ws);

  send(ws, {
    t: 'joined',
    you: { id, name: finalName },
    room: roomKey,
    users: roster(roomKey),
    renamed: finalName !== name,
  });
  broadcastRoster(roomKey);
}

function handleRename(ws, m) {
  const u = ws.user;
  if (!u) return err(ws, 'NOT_IN_ROOM', 'Join a room first.');
  const name = cleanName(m.name);
  if (!name) return err(ws, 'NAME_INVALID', 'Enter a display name (1-20 characters).');
  u.name = uniqueName(u.room, name, u.id);
  send(ws, { t: 'renamed', you: { id: u.id, name: u.name }, renamed: u.name !== name });
  broadcastRoster(u.room);
}

function handleSelect(ws, m) {
  const u = ws.user;
  if (!u) return err(ws, 'NOT_IN_ROOM', 'Join a room first.');
  const room = rooms.get(u.room);
  if (m.target === null || m.target === undefined) {
    u.selected = null;
  } else if (typeof m.target === 'string' && m.target !== u.id && room && room.has(m.target)) {
    u.selected = m.target;
  } else {
    u.selected = null;
    err(ws, 'TARGET_GONE', 'That user is no longer in the room.');
  }
  broadcastRoster(u.room);
}

function handleInteract(ws, m) {
  const u = ws.user;
  if (!u) return err(ws, 'NOT_IN_ROOM', 'Join a room first.');
  if (typeof m.action !== 'string' || !ACTIONS.has(m.action)) return err(ws, 'BAD_ACTION', 'Unknown command.');

  const now = Date.now();
  u.hits = u.hits.filter((t) => now - t < 2000);
  if (u.hits.length >= 8) return err(ws, 'RATE_LIMIT', 'Slow down.');
  u.hits.push(now);

  const room = rooms.get(u.room); // lookup is room-scoped: cross-room targets are simply "gone"
  const target = room && typeof m.target === 'string' ? room.get(m.target) : null;
  if (!target || target === ws) {
    u.selected = null;
    err(ws, 'TARGET_GONE', 'That user is no longer in the room.');
    broadcastRoster(u.room);
    return;
  }
  send(target, { t: 'interaction', from: { id: u.id, name: u.name }, action: m.action });
  send(ws, { t: 'ack', to: { id: target.user.id, name: target.user.name }, action: m.action });
}

wss.on('connection', (ws) => {
  ws.user = null;
  ws.isAlive = true;
  ws.winStart = Date.now();
  ws.winCount = 0;

  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    ws.isAlive = true;
    // flood guard: > 40 msgs/sec -> drop
    const now = Date.now();
    if (now - ws.winStart > 1000) {
      ws.winStart = now;
      ws.winCount = 0;
    }
    if (++ws.winCount > 40) return ws.close(1008, 'rate limit');

    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;

    switch (m.t) {
      case 'join': return handleJoin(ws, m);
      case 'leave': leaveRoom(ws); return send(ws, { t: 'left' });
      case 'rename': return handleRename(ws, m);
      case 'select': return handleSelect(ws, m);
      case 'interact': return handleInteract(ws, m);
      case 'ping': return send(ws, { t: 'pong' });
      default: return;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

// Detect half-open connections (laptop lid closed, wifi dropped, ...) and clean them out.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate(); // fires 'close' -> leaveRoom -> roster update
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 20000);
wss.on('close', () => clearInterval(heartbeat));

if (require.main === module) {
  server.listen(PORT, () => console.log(`Tactical comms server on http://localhost:${PORT}`));
  const shutdown = () => {
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { server, wss, rooms };
