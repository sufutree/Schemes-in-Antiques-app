// 古董局中局：伺服器端遊戲邏輯（純函式，不碰儲存）
import { randomInt, randomUUID } from 'node:crypto';

export const ZODIAC = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'];
export const ROLES = {
  xy: { name: '許願', camp: 'good', desc: '許願陣營首領。每次輪到時可以鑑定兩件寶物。' },
  fz: { name: '方震', camp: 'good', desc: '沒有鑑寶能力，但每次輪到時可以查看一位玩家的陣營。若被藥不然偷襲，許願也會一併被偷襲。' },
  mh: { name: '木戶加奈', camp: 'good', desc: '隨機有一輪無法鑑定寶物（輪到時才會知道）。' },
  hy: { name: '黃煙煙', camp: 'good', desc: '隨機有一輪無法鑑定寶物（輪到時才會知道）。' },
  jf: { name: '姬云浮', camp: 'good', desc: '鑑定結果不受老朝奉影響。若被藥不然偷襲，整場遊戲都無法鑑定。' },
  lc: { name: '老朝奉', camp: 'bad', desc: '鑑定後可選擇發動：本輪排在你後面的玩家（己方陣營與姬云浮除外）看到的真假互換。' },
  yb: { name: '藥不然', camp: 'bad', desc: '鑑定後可偷襲一名玩家，對方下次輪到時無法鑑定或發動能力。' },
  zg: { name: '鄭國渠', camp: 'bad', desc: '你不知道誰是隊友。鑑定後可覆蓋一件寶物，之後鑑定它的人只會看到「無法鑑定」。' }
};
export const ROLE_SETS = {
  6: ['xy', 'fz', 'mh', 'hy', 'lc', 'yb'],
  7: ['xy', 'fz', 'mh', 'hy', 'lc', 'yb', 'zg'],
  8: ['xy', 'fz', 'mh', 'hy', 'jf', 'lc', 'yb', 'zg']
};
export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 8;
const CHIPS_PER_ROUND = 2;
const ABILITY_ROLES = ['lc', 'yb', 'zg', 'fz'];

export class GameError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
const fail = (msg, status = 409) => { throw new GameError(msg, status); };
const need = (cond, msg = '現在不能這樣做') => { if (!cond) fail(msg); };

const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const campName = c => c === 'good' ? '許願陣營' : '老朝奉陣營';
const resultText = r => r === 'real' ? '真品' : r === 'fake' ? '贗品' : '無法鑑定';

export function cleanName(n) {
  n = String(n || '').trim().replace(/\s+/g, ' ');
  if (!n) fail('請輸入名字', 400);
  if ([...n].length > 8) fail('名字最多 8 個字', 400);
  return n;
}

/* ---------- 房間 ---------- */

export function newRoom(code, name) {
  const token = randomUUID();
  const state = { v: 1, code, created: Date.now(), hostToken: token, players: [{ token, name: cleanName(name) }], phase: 'lobby', g: null };
  return { state, token };
}

// 回傳玩家 token；帶著原本 token 回來就是重新連線
export function join(state, name, token) {
  if (token && state.players.some(p => p.token === token)) return token;
  if (state.phase !== 'lobby') fail('這局已經開始，無法加入。原本的玩家請用「重連連結」回來。');
  name = cleanName(name);
  if (state.players.length >= MAX_PLAYERS) fail('房間已滿（最多 8 人）');
  if (state.players.some(p => p.name === name)) fail('這個名字已經有人用了，換一個吧');
  const t = randomUUID();
  state.players.push({ token: t, name });
  return t;
}

/* ---------- 遊戲流程 ---------- */

function startGame(state) {
  const n = state.players.length;
  const roles = shuffle(ROLE_SETS[n]);
  const realIds = shuffle(ZODIAC.map((_, i) => i)).slice(0, 6);
  const heads = ZODIAC.map((z, i) => ({ z, real: realIds.includes(i) }));
  const R = shuffle(realIds);
  const F = shuffle(ZODIAC.map((_, i) => i).filter(i => !realIds.includes(i)));
  const rounds = [0, 1, 2].map(k => [R[2 * k], R[2 * k + 1], F[2 * k], F[2 * k + 1]].sort((a, b) => a - b));
  const blocked = {};
  roles.forEach((r, i) => { if (r === 'mh' || r === 'hy') blocked[i] = randomInt(3); });
  state.g = {
    id: randomUUID().slice(0, 8), roles, heads, rounds, blocked, round: 0, startIdx: randomInt(n),
    ready: Array(n).fill(false), chips: Array(n).fill(0), attacked: Array(n).fill(false), perm: false,
    swap: false, covered: [], acted: [], chain: [[], [], []], hist: Array.from({ length: n }, () => []),
    turn: null, speak: null, ballots: {}, plog: [], guesses: {}, finalists: [], last: null
  };
  state.phase = 'deal';
}

function addHist(g, p, t) { g.hist[p].push('第' + (g.round + 1) + '輪　' + t); }

function beginRound(state) {
  const g = state.g;
  g.acted = []; g.swap = false; g.covered = []; g.ballots = {};
  g.chips = g.chips.map(c => c + CHIPS_PER_ROUND);
  state.phase = 'turn';
  beginTurn(g, g.startIdx);
}

function beginTurn(g, p) {
  const role = g.roles[p];
  let b = null;
  if (role === 'jf' && g.perm) { b = 'perm'; g.attacked[p] = false; }
  else if (g.attacked[p]) { b = 'attack'; g.attacked[p] = false; }
  else if (g.blocked[p] === g.round) b = 'round';
  g.turn = { p, step: b ? 'blocked' : 'pick', blocked: b, results: [], left: role === 'xy' ? 2 : 1, msg: null };
  g.chain[g.round].push(p);
  if (b) addHist(g, p, b === 'round' ? '本輪無法鑑定' : '被藥不然偷襲，無法行動');
}

function toNext(state) {
  const g = state.g, p = g.turn.p;
  if (!g.acted.includes(p)) g.acted.push(p);
  if (g.acted.length < state.players.length) { g.turn.step = 'next'; return; }
  // 所有人都行動過了：進入發言，從尾家左手邊（下一個座位）開始
  const n = state.players.length;
  g.last = p; g.turn = null;
  g.speak = { order: Array.from({ length: n }, (_, k) => (p + 1 + k) % n), i: 0 };
  state.phase = 'discuss';
}

function rank(ids, totals) {
  return ids.map((id, k) => ({ id, v: totals[k] })).sort((a, b) => b.v - a.v || a.id - b.id);
}

function tally(state) {
  const g = state.g, ids = g.rounds[g.round];
  const totals = [0, 0, 0, 0];
  for (const [p, arr] of Object.entries(g.ballots)) {
    arr.forEach((v, k) => { totals[k] += v; });
    g.chips[p] -= arr.reduce((s, v) => s + v, 0);
  }
  const order = rank(ids, totals);
  g.plog.push({ round: g.round, ids, totals, order, top1: order[0].id, top2: order[1].id, ballots: { ...g.ballots } });
  state.phase = 'reveal';
}

function found(g) { return g.plog.reduce((s, L) => s + (g.heads[L.top1].real ? 1 : 0) + (g.heads[L.top2].real ? 1 : 0), 0); }

export function scoreCalc(g) {
  const at = k => g.roles.indexOf(k);
  const xy = at('xy'), fz = at('fz'), lc = at('lc'), yb = at('yb');
  const f = found(g);
  const goods = g.roles.map((r, i) => i).filter(i => ROLES[g.roles[i]].camp === 'good');
  const correct = goods.filter(i => g.guesses[i] === lc).length;
  const majority = correct * 2 >= goods.length; // 規則：過半（含）
  const direct = f === 6;
  const parts = [{ t: '找回真品 ' + f + ' 件', v: f }];
  if (!direct) {
    const lcHit = g.guesses[lc] === xy, ybHit = g.guesses[yb] === fz;
    parts.push({ t: '許願' + (lcHit ? '被老朝奉找到' : '沒有被老朝奉找到'), v: lcHit ? 0 : 2 });
    parts.push({ t: '方震' + (ybHit ? '被藥不然找到' : '沒有被藥不然找到'), v: ybHit ? 0 : 1 });
    parts.push({ t: '好人指認老朝奉：' + correct + ' / ' + goods.length + ' 人' + (majority ? '（過半）' : '（未過半）'), v: majority ? 1 : 0 });
  }
  const total = parts.reduce((s, x) => s + x.v, 0);
  return { found: f, direct, parts, total, win: direct || total >= 6 };
}

/* ---------- 動作 ---------- */

export function act(state, token, type, d = {}) {
  const me = state.players.findIndex(p => p.token === token);
  if (me < 0) fail('你已經不在這個房間了', 403);
  const n = state.players.length;
  const isHost = token === state.hostToken;
  const g = state.g;
  const hostOnly = () => need(isHost, '只有房主可以這樣做');
  const phase = ph => need(state.phase === ph);
  const player = x => { const i = Number(x); need(Number.isInteger(i) && i >= 0 && i < n, '找不到這位玩家'); return i; };

  switch (type) {
    /* 大廳 */
    case 'kick': {
      hostOnly(); phase('lobby');
      const i = player(d.i); need(i !== me, '不能把自己移出');
      state.players.splice(i, 1); return;
    }
    case 'move': {
      hostOnly(); phase('lobby');
      const i = player(d.i), j = i + (Number(d.dir) < 0 ? -1 : 1);
      need(j >= 0 && j < n);
      [state.players[i], state.players[j]] = [state.players[j], state.players[i]]; return;
    }
    case 'leave': {
      phase('lobby');
      state.players.splice(me, 1);
      if (isHost && state.players.length) state.hostToken = state.players[0].token;
      return;
    }
    case 'start':
      hostOnly(); phase('lobby');
      need(n >= MIN_PLAYERS && n <= MAX_PLAYERS, '需要 6–8 人才能開局（目前 ' + n + ' 人）');
      startGame(state); return;
    case 'abort':
      hostOnly(); need(state.phase !== 'lobby');
      state.phase = 'lobby'; state.g = null; return;
    case 'again':
      hostOnly(); phase('end');
      state.phase = 'lobby'; state.g = null; return;
    case 'force': // 房主代為操作：有人卡住時讓遊戲繼續
      hostOnly();
      if (state.phase === 'deal') { g.ready.fill(true); beginRound(state); return; }
      if (state.phase === 'vote') {
        state.players.forEach((_, i) => { if (!g.ballots[i]) g.ballots[i] = [0, 0, 0, 0]; });
        tally(state); return;
      }
      if (state.phase === 'final') { state.phase = 'end'; return; }
      if (state.phase === 'turn') {
        const p = g.turn.p;
        addHist(g, p, '房主代為結束回合');
        toNext(state);
        if (state.phase === 'turn') {
          const rest = state.players.map((_, i) => i).filter(i => !g.acted.includes(i));
          const to = rest[randomInt(rest.length)];
          addHist(g, p, '派票給 ' + state.players[to].name + '（房主代為隨機）');
          beginTurn(g, to);
        }
        return;
      }
      fail('現在沒有需要代為操作的事');

    /* 看身份 */
    case 'ready':
      phase('deal');
      g.ready[me] = true;
      if (g.ready.every(Boolean)) beginRound(state);
      return;

    /* 發言 */
    case 'spoke':
      phase('discuss');
      need(me === g.speak.order[g.speak.i] || isHost, '還沒輪到你發言');
      g.speak.i++;
      if (g.speak.i >= n) state.phase = 'vote';
      return;
    case 'tovote':
      hostOnly(); phase('discuss');
      state.phase = 'vote'; return;

    /* 投票 */
    case 'vote': {
      phase('vote');
      const arr = Array.isArray(d.votes) ? d.votes.map(Number) : [];
      need(arr.length === 4 && arr.every(v => Number.isInteger(v) && v >= 0), '票數格式不對');
      const used = arr.reduce((s, v) => s + v, 0);
      need(used <= g.chips[me], '票數超過你手上的籌碼');
      need(g.round < 2 || used === g.chips[me], '最後一輪要把手上的籌碼全部投完');
      g.ballots[me] = arr;
      if (Object.keys(g.ballots).length === n) tally(state);
      return;
    }
    case 'unvote':
      phase('vote');
      delete g.ballots[me]; return;
    case 'next':
      hostOnly(); phase('reveal');
      if (g.round < 2) { g.round++; g.startIdx = g.last; beginRound(state); return; }
      if (found(g) === 6) { state.phase = 'end'; return; }
      g.finalists = g.roles.map((r, i) => i).filter(i => g.roles[i] !== 'zg');
      state.phase = 'final'; return;

    /* 身份揭露 */
    case 'guess': {
      phase('final');
      need(g.finalists.includes(me), '你不需要指認');
      need(g.guesses[me] === undefined, '你已經指認過了');
      const i = player(d.i); need(i !== me, '不能指認自己');
      g.guesses[me] = i;
      if (g.finalists.every(p => g.guesses[p] !== undefined)) state.phase = 'end';
      return;
    }
  }

  /* 以下都是輪到自己行動時的動作 */
  phase('turn');
  const t = g.turn;
  need(t.p === me, '還沒輪到你');
  const role = g.roles[me];
  const step = s => need(t.step === s);
  const inRound = x => { const id = Number(x); need(g.rounds[g.round].includes(id), '這件寶物不在本輪'); return id; };

  switch (type) {
    case 'appraise': {
      step('pick');
      const id = inRound(d.id);
      need(!t.results.some(x => x.id === id), '這件已經鑑定過了');
      let r;
      if (g.covered.includes(id)) r = 'none';
      else {
        let real = g.heads[id].real;
        if (g.swap && ROLES[role].camp === 'good' && role !== 'jf') real = !real;
        r = real ? 'real' : 'fake';
      }
      t.results.push({ id, r }); t.left--; t.step = 'result';
      addHist(g, me, '鑑定 ' + ZODIAC[id] + '首：' + resultText(r));
      return;
    }
    case 'more': step('result'); need(t.left > 0); t.step = 'pick'; return;
    case 'after':
      step('result'); need(t.left === 0);
      if (ABILITY_ROLES.includes(role)) t.step = 'ability'; else toNext(state);
      return;
    case 'skip': step('ability'); toNext(state); return;
    case 'swapon':
      step('ability'); need(role === 'lc' && !g.swap);
      g.swap = true; addHist(g, me, '發動換真假'); toNext(state); return;
    case 'attack': {
      step('ability'); need(role === 'yb');
      const i = player(d.i); need(i !== me, '不能偷襲自己');
      g.attacked[i] = true;
      if (g.roles[i] === 'fz') g.attacked[g.roles.indexOf('xy')] = true;
      if (g.roles[i] === 'jf') g.perm = true;
      addHist(g, me, '偷襲了 ' + state.players[i].name); toNext(state); return;
    }
    case 'cover': {
      step('ability'); need(role === 'zg');
      const id = inRound(d.id); need(!g.covered.includes(id), '這件已經被覆蓋了');
      g.covered.push(id); addHist(g, me, '覆蓋了 ' + ZODIAC[id] + '首'); toNext(state); return;
    }
    case 'viewcamp': {
      step('ability'); need(role === 'fz');
      const i = player(d.i); need(i !== me);
      const txt = state.players[i].name + ' 是' + campName(ROLES[g.roles[i]].camp);
      addHist(g, me, '查驗：' + txt); t.msg = txt; t.step = 'info'; return;
    }
    case 'infook': step('info'); toNext(state); return;
    case 'blockedok': step('blocked'); toNext(state); return;
    case 'pass': {
      step('next');
      const i = player(d.i); need(!g.acted.includes(i), '這位玩家本輪已經行動過了');
      addHist(g, me, '派票給 ' + state.players[i].name);
      beginTurn(g, i); return;
    }
  }
  fail('不認得的動作', 400);
}

/* ---------- 每個玩家只看得到自己該看的 ---------- */

export function viewFor(state, token) {
  const me = state.players.findIndex(p => p.token === token);
  if (me < 0) fail('你已經不在這個房間了（可能被房主移出）', 403);
  const host = state.players.findIndex(p => p.token === state.hostToken);
  const base = { v: state.v, code: state.code, phase: state.phase, me, host, players: state.players.map(p => p.name) };
  const g = state.g;
  if (!g) return base;

  const role = g.roles[me], R = ROLES[role];
  let mate = null;
  if (role === 'lc') mate = { i: g.roles.indexOf('yb'), role: '藥不然' };
  if (role === 'yb') mate = { i: g.roles.indexOf('lc'), role: '老朝奉' };
  const v = {
    ...base,
    mine: { role, name: R.name, camp: R.camp, desc: R.desc, mate, hist: g.hist[me], chips: g.chips[me] },
    round: g.round,
    current: g.rounds[g.round],
    chain: g.chain[g.round],
    chains: g.chain,
    actor: g.turn ? g.turn.p : null,
    ready: g.ready,
    speak: g.speak,
    voted: Object.keys(g.ballots).map(Number),
    myBallot: g.ballots[me] || null,
    plog: g.plog.map(L => ({ round: L.round, ids: L.ids, totals: L.totals, order: L.order, top2real: g.heads[L.top2].real, ballots: L.ballots })),
    last: g.last
  };
  if (g.turn && g.turn.p === me) {
    v.turn = { ...g.turn, acted: g.acted };
    if (role === 'zg') v.turn.covered = g.covered;
    if (role === 'lc') v.turn.swap = g.swap;
  }
  if (state.phase === 'final') {
    v.finalists = g.finalists;
    v.guessed = Object.keys(g.guesses).map(Number);
    v.myGuess = g.guesses[me] ?? null;
  }
  if (state.phase === 'end') {
    v.reveal = { roles: g.roles.map(k => ({ key: k, name: ROLES[k].name, camp: ROLES[k].camp })), real: g.heads.map(h => h.real), guesses: g.guesses, hist: g.hist, score: scoreCalc(g) };
  }
  return v;
}
