// HTTP + Socket.IO сервер покерного мини-аппа.
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { Server } from 'socket.io';
import { Table } from './src/table.js';

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // если задан — проверяем подпись initData

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const tables = new Map(); // id -> Table

function genId() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

// Проверка Telegram initData (по документации Mini Apps). Возвращает user или null.
function verifyInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    if (BOT_TOKEN) {
      const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
      const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
      if (calc !== hash) return null;
    }
    const user = JSON.parse(params.get('user'));
    return { id: String(user.id), name: user.first_name + (user.last_name ? ' ' + user.last_name : '') };
  } catch { return null; }
}

function identify(socket, payload) {
  // 1) валидный Telegram initData; 2) фолбэк для теста в браузере
  if (payload?.initData) {
    const u = verifyInitData(payload.initData);
    if (u) return u;
  }
  if (payload?.devUser) {
    return { id: 'dev-' + payload.devUser.id, name: payload.devUser.name };
  }
  return null;
}

function broadcast(table) {
  for (const [sid, s] of io.sockets.sockets) {
    if (s.data.tableId === table.id && s.data.user) {
      s.emit('state', table.stateFor(s.data.user.id));
    }
  }
}

io.on('connection', (socket) => {
  socket.on('hello', (payload, cb) => {
    const user = identify(socket, payload);
    if (!user) return cb?.({ ok: false, err: 'Не удалось авторизоваться' });
    socket.data.user = user;
    cb?.({ ok: true, user });
  });

  socket.on('createTable', (opts, cb) => {
    if (!socket.data.user) return cb?.({ ok: false, err: 'Нет авторизации' });
    let id = genId();
    while (tables.has(id)) id = genId();
    const t = new Table(id, opts || {});
    tables.set(id, t);
    cb?.({ ok: true, tableId: id });
  });

  socket.on('joinTable', ({ tableId }, cb) => {
    const t = tables.get((tableId || '').toUpperCase());
    if (!t) return cb?.({ ok: false, err: 'Стол не найден' });
    if (!socket.data.user) return cb?.({ ok: false, err: 'Нет авторизации' });
    const pos = t.seatPlayer(socket.data.user);
    if (pos < 0) return cb?.({ ok: false, err: 'Мест нет' });
    socket.data.tableId = t.id;
    cb?.({ ok: true, tableId: t.id });
    broadcast(t);
  });

  socket.on('startHand', (_, cb) => {
    const t = tables.get(socket.data.tableId);
    if (!t) return cb?.({ ok: false, err: 'Нет стола' });
    if (t.phase !== 'waiting' && t.phase !== 'showdown') return cb?.({ ok: false, err: 'Раздача уже идёт' });
    if (!t.startHand()) return cb?.({ ok: false, err: 'Нужно минимум 2 игрока с фишками' });
    cb?.({ ok: true });
    broadcast(t);
  });

  socket.on('action', ({ action, amount }, cb) => {
    const t = tables.get(socket.data.tableId);
    if (!t) return cb?.({ ok: false, err: 'Нет стола' });
    const res = t.act(socket.data.user.id, action, amount);
    cb?.(res);
    if (res.ok) broadcast(t);
  });

  socket.on('leaveTable', (_, cb) => {
    const t = tables.get(socket.data.tableId);
    if (t && socket.data.user) { t.removePlayer(socket.data.user.id); broadcast(t); }
    socket.data.tableId = null;
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const t = tables.get(socket.data.tableId);
    if (t && socket.data.user) {
      const p = t.seats.find((x) => x && x.id === socket.data.user.id);
      if (p) p.connected = false;
      broadcast(t);
    }
  });
});

// Периодическая уборка пустых столов
setInterval(() => {
  for (const [id, t] of tables) if (t.activeCount() === 0) tables.delete(id);
}, 60000);

server.listen(PORT, () => console.log(`Poker mini-app на порту ${PORT}`));
