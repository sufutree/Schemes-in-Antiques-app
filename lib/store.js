// 房間儲存：有設定 Upstash Redis 就用 Redis，否則用記憶體（只適合本機測試）
const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 12; // 房間 12 小時沒動作就自動消失

export const usingRedis = Boolean(URL && TOKEN);

// Vercel 上會同時開好幾台機器，記憶體不共用，沒有 Redis 房間會時有時無，所以直接報錯
function requireStore() {
  if (!usingRedis && process.env.VERCEL) throw new Error('伺服器還沒接上資料庫：請在 Vercel 專案的 Storage 連接 Upstash Redis，然後 Redeploy');
}

async function redis(...args) {
  const r = await fetch(URL, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(args) });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

// 版本號相同才寫入（避免兩支手機同時按造成狀態互相覆蓋）
const CAS = `
local cur = redis.call('GET', KEYS[2])
if (cur or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
return 1`;

const mem = globalThis.__gdjRooms || (globalThis.__gdjRooms = new Map());
const key = code => 'gdj:room:' + code;
const vkey = code => 'gdj:room:' + code + ':v';

export async function getRoom(code) {
  requireStore();
  if (!usingRedis) { const s = mem.get(code); return s ? JSON.parse(s) : null; }
  // 用 Lua 讀，確保讀的是主資料庫（Upstash 的讀取副本可能還沒同步到剛寫入的資料）
  const s = await redis('EVAL', "return redis.call('GET', KEYS[1])", 1, key(code));
  return s ? JSON.parse(s) : null;
}

// 只在房號沒人用時建立，成功回傳 true
export async function createRoom(state) {
  requireStore();
  const json = JSON.stringify(state);
  if (!usingRedis) { if (mem.has(state.code)) return false; mem.set(state.code, json); return true; }
  const ok = await redis('SET', key(state.code), json, 'NX', 'EX', TTL);
  if (ok !== 'OK') return false;
  await redis('SET', vkey(state.code), String(state.v), 'EX', TTL);
  return true;
}

async function saveIfVersion(state, prevV) {
  const json = JSON.stringify(state);
  if (!usingRedis) {
    const cur = mem.get(state.code);
    if (!cur || JSON.parse(cur).v !== prevV) return false;
    mem.set(state.code, json); return true;
  }
  return (await redis('EVAL', CAS, 2, key(state.code), vkey(state.code), String(prevV), json, String(state.v), TTL)) === 1;
}

// 讀取 → 修改 → 寫回；撞到別人同時寫入就重試
export async function mutate(code, fn) {
  for (let tries = 0; tries < 6; tries++) {
    const state = await getRoom(code);
    if (!state) return { state: null };
    const prevV = state.v;
    const out = fn(state);
    state.v = prevV + 1;
    if (await saveIfVersion(state, prevV)) return { state, out };
    await new Promise(r => setTimeout(r, 40 + Math.random() * 80));
  }
  throw new Error('伺服器忙碌，請再按一次');
}

// 私人筆記：每個玩家一個 key，只有拿著自己 token 的人讀得到
const nkey = (code, gid, token) => 'gdj:note:' + code + ':' + gid + ':' + token;

export async function getNotes(code, gid, token) {
  requireStore();
  const k = nkey(code, gid, token);
  if (!usingRedis) return mem.get(k) || null;
  return await redis('EVAL', "return redis.call('GET', KEYS[1])", 1, k);
}

export async function setNotes(code, gid, token, json) {
  requireStore();
  const k = nkey(code, gid, token);
  if (!usingRedis) { mem.set(k, json); return; }
  await redis('SET', k, json, 'EX', TTL);
}
