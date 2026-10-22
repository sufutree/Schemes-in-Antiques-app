// 唯一的 API：/api/game
//   GET  ?op=state&room=1234&t=<token>&v=<目前版本>   取得自己看得到的遊戲畫面
//   POST { op:'create', name }                        開房
//   POST { op:'join', room, name, t? }                加入（帶 t 就是重新連線）
//   POST { op:'act', room, t, type, data }            遊戲動作
import { randomInt } from 'node:crypto';
import { newRoom, join, act, viewFor, GameError } from '../lib/game.js';
import { getRoom, createRoom, mutate } from '../lib/store.js';

const roomCode = x => { const c = String(x || '').trim(); if (!/^\d{4}$/.test(c)) throw new GameError('房號是 4 位數字', 400); return c; };
const notFound = () => { throw new GameError('找不到這個房間（可能已過期）', 404); };

async function handle(req) {
  const q = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}) : req.query;

  switch (q.op) {
    case 'state': {
      const state = await getRoom(roomCode(q.room));
      if (!state) notFound();
      if (String(state.v) === String(q.v)) return { same: true };
      return { view: viewFor(state, q.t) };
    }
    case 'create': {
      for (let i = 0; i < 20; i++) {
        const { state, token } = newRoom(String(randomInt(1000, 10000)), q.name);
        if (await createRoom(state)) return { room: state.code, token, view: viewFor(state, token) };
      }
      throw new Error('暫時開不了房，請再試一次');
    }
    case 'join': {
      const room = roomCode(q.room);
      const { state, out: token } = await mutate(room, s => join(s, q.name, q.t));
      if (!state) notFound();
      return { room, token, view: viewFor(state, token) };
    }
    case 'act': {
      const { state } = await mutate(roomCode(q.room), s => act(s, q.t, q.type, q.data || {}));
      if (!state) notFound();
      if (q.type === 'leave') return { left: true };
      return { view: viewFor(state, q.t) };
    }
  }
  throw new GameError('未知的請求', 400);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await handle(req));
  } catch (e) {
    const status = e instanceof GameError ? e.status : 500;
    if (status === 500) console.error(e);
    res.status(status).json({ error: e.message || '伺服器錯誤' });
  }
}
