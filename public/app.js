/* 古董局中局 — 每人一支手機的前端。遊戲狀態都在伺服器，這裡只負責顯示與送出動作。 */
const ZODIAC = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'];
const ROLE_LIST = [
  ['許願', 'good', '首領，每次可鑑定兩件寶物。'],
  ['方震', 'good', '不能鑑定，每次可查看一位玩家的陣營。被偷襲時許願也會被偷襲。'],
  ['木戶加奈', 'good', '隨機有一輪無法鑑定。'],
  ['黃煙煙', 'good', '隨機有一輪無法鑑定。'],
  ['姬云浮', 'good', '不受老朝奉影響；被偷襲後整場無法鑑定。（8 人局）'],
  ['老朝奉', 'bad', '可讓本輪後面的好人看到的真假互換。'],
  ['藥不然', 'bad', '可偷襲一人，讓對方下次輪到時無法行動。'],
  ['鄭國渠', 'bad', '不知道隊友。可覆蓋一件寶物讓人無法鑑定。（7 人以上）']
];
const SETS = { 6: '許願、方震、木戶加奈、黃煙煙　對　老朝奉、藥不然', 7: '6 人配置再加入鄭國渠', 8: '7 人配置再加入姬云浮' };
const API = '/api/game';
const SKEY = 'gdj-session-v2';
const NKEY = 'gdj-name';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

let sess = store.get(SKEY); // { room, token }
let V = null;               // 伺服器給我的畫面資料
const U = { name: store.get(NKEY) || '', code: '', resume: null, info: false, showRole: false, draft: null, draftRound: -1, arm: null, net: false, busy: false, msg: '' };

// 網址：?r=1234 邀請連結；?r=1234&t=xxx 重連連結
(function readUrl() {
  const q = new URLSearchParams(location.search);
  const r = q.get('r'), t = q.get('t');
  if (r && t) { sess = { room: r, token: t }; store.set(SKEY, sess); }
  else if (r) {
    U.code = r;
    if (sess && sess.room !== r) { U.resume = sess; sess = null; }
  }
  if (r) history.replaceState(null, '', location.pathname);
})();

/* ---------- 小工具 ---------- */
const pn = i => esc(V.players[i]);
const campName = c => c === 'good' ? '許願陣營' : '老朝奉陣營';
const campCls = c => c === 'good' ? 'camp-good' : 'camp-bad';
const isHost = () => V.me === V.host;
const sum = a => a.reduce((s, x) => s + x, 0);
const z = id => ZODIAC[id];

let toastTimer;
function toast(msg) {
  $toast.textContent = msg; $toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $toast.hidden = true; }, 3200);
}
function buzz(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch (e) {} }

let wake = null;
async function keepAwake() {
  if (!sess || wake || !('wakeLock' in navigator) || document.hidden) return;
  try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch (e) {}
}

/* ---------- 與伺服器溝通 ---------- */
async function post(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: '連線失敗，請再試一次' }));
  if (!r.ok) { const e = new Error(j.error || '連線失敗'); e.status = r.status; throw e; }
  return j;
}

function dropSession(msg) {
  sess = null; V = null; store.del(SKEY);
  U.msg = msg || ''; U.info = false;
  render();
}

function enter(j) {
  sess = { room: j.room, token: j.token }; store.set(SKEY, sess);
  U.resume = null; U.msg = '';
  setView(j.view);
  poll();
}

async function send(type, data) {
  if (U.busy) return;
  U.busy = true;
  try {
    const j = await post({ op: 'act', room: sess.room, t: sess.token, type, data });
    if (j.left) return dropSession('你已離開房間。');
    setView(j.view);
  } catch (e) {
    if (e.status === 403 || e.status === 404) dropSession(e.message); else toast(e.message);
  } finally { U.busy = false; }
}

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  if (!sess) return;
  try {
    const url = API + '?op=state&room=' + encodeURIComponent(sess.room) + '&t=' + encodeURIComponent(sess.token) + '&v=' + (V ? V.v : '');
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json();
    if (r.status === 403 || r.status === 404) return dropSession(j.error);
    if (!r.ok) throw new Error(j.error);
    if (U.net) { U.net = false; render(true); }
    if (!j.same) setView(j.view, true);
  } catch (e) {
    if (!U.net) { U.net = true; render(true); }
  }
  if (sess) pollTimer = setTimeout(poll, document.hidden ? 8000 : 1500);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); keepAwake(); } });

/* ---------- 狀態更新與提醒 ---------- */
const myTurn = v => v && v.phase === 'turn' && v.actor === v.me;
const mySpeech = v => v && v.phase === 'discuss' && v.speak.order[v.speak.i] === v.me;

function setView(view, fromPoll) {
  if (V && view.v < V.v) return; // 舊的回應晚到，丟掉
  const prev = V;
  V = view;
  if (prev && prev.phase !== V.phase) { U.showRole = false; U.arm = null; }
  if (V.phase === 'vote' && (U.draft === null || U.draftRound !== V.round)) { U.draft = [0, 0, 0, 0]; U.draftRound = V.round; }
  if ((myTurn(V) && !myTurn(prev)) || (mySpeech(V) && !mySpeech(prev))) buzz([180, 80, 180]);
  else if (prev && prev.phase !== V.phase && ['vote', 'reveal', 'final', 'end'].includes(V.phase)) buzz(120);
  document.title = (myTurn(V) ? '● 輪到你了 — ' : mySpeech(V) ? '● 輪到你發言 — ' : '') + '古董局中局';
  render(fromPoll);
}

/* ---------- 共用畫面元件 ---------- */
function header() {
  const dots = V && V.phase !== 'lobby' && V.round !== undefined
    ? '<div class="dots" aria-label="第 ' + (V.round + 1) + ' 輪">' + [0, 1, 2].map(i => '<i class="' + (i <= V.round ? 'on' : '') + '"></i>').join('') + '<span>第 ' + (V.round + 1) + ' 輪</span></div>' : '';
  const room = V ? '<span class="badge">房號 ' + esc(V.code) + '</span>' : '';
  return '<header><div class="brand"><span class="seal">局</span><b>古董局中局</b></div><div class="row" style="gap:8px">' + dots + room + '</div></header>' +
    (U.net ? '<p class="net">連線不穩，正在重試…</p>' : '');
}

function headTiles(ids, opts) {
  opts = opts || {};
  return '<div class="heads">' + ids.map(id => {
    const off = opts.disabled && opts.disabled.includes(id);
    const cov = opts.covered && opts.covered.includes(id) ? ' cov' : '';
    const attrs = opts.act && !off ? 'data-s="' + opts.act + '" data-id="' + id + '"' : 'disabled';
    return '<button class="tile' + (off ? ' off' : '') + cov + '" ' + attrs + '><span class="z">' + z(id) + '</span><small>' + z(id) + '首' + (cov ? '・已覆蓋' : '') + '</small></button>';
  }).join('') + '</div>';
}

function board() {
  const cells = ZODIAC.map((name, id) => {
    let cls = '', tag = '';
    const L = V.plog.find(L => L.ids.includes(id));
    if (L) {
      if (L.order[0].id === id) { cls = 'now'; tag = '護・不明'; }
      else if (L.order[1].id === id) { cls = L.top2real ? 'real' : 'fake'; tag = L.top2real ? '護・真' : '護・贗'; }
      else { cls = 'gone'; tag = '未保護'; }
    } else if (V.current.includes(id)) { cls = 'now'; tag = '本輪'; }
    return '<div class="cell ' + cls + '"><b>' + name + '</b><small>' + tag + '</small></div>';
  }).join('');
  return '<div class="panel"><div class="label">十二獸首總覽</div><div class="board">' + cells + '</div></div>';
}

function pickList(idxs, act) {
  return idxs.map(i => '<button class="pick" data-s="' + act + '" data-i="' + i + '"><span>' + pn(i) + '</span></button>').join('');
}

function progressChips(doneFn, nowIdx) {
  return '<div class="chips">' + V.players.map((n, i) => '<span class="chip' + (doneFn(i) ? ' done' : '') + (i === nowIdx ? ' now' : '') + (i === V.me ? ' me' : '') + '">' + (doneFn(i) ? '✓ ' : '') + esc(n) + '</span>').join('') + '</div>';
}

function rulesBlock() {
  return '<details><summary class="muted">角色速覽</summary><table><tbody>' +
    ROLE_LIST.map(r => '<tr><td class="' + campCls(r[1]) + '" style="white-space:nowrap">' + r[0] + '</td><td class="muted">' + r[2] + '</td></tr>').join('') +
    '</tbody></table><p class="muted" style="margin-top:8px">三輪後，若六件真品全被保護，好人直接獲勝；否則老朝奉猜許願、藥不然猜方震、好人猜老朝奉，好人總分 6 分以上獲勝。</p></details>';
}

/* ---------- 各階段畫面 ---------- */
function vHome() {
  return '<div class="panel"><div class="label">開局</div><h1>十二獸首，六真六假</h1>' +
    '<p class="muted">6–8 人，每人用自己的手機加入同一個房間。身份、鑑定結果只會出現在自己的手機上。</p>' + rulesBlock() + '</div>' +
    (U.msg ? '<p class="err">' + esc(U.msg) + '</p>' : '') +
    (U.resume ? '<button class="btn ghost" data-act="resume">回到原本的房間 ' + esc(U.resume.room) + '</button>' : '') +
    '<div class="panel"><label class="label" for="name">你的名字</label>' +
    '<input type="text" id="name" maxlength="8" placeholder="最多 8 個字" value="' + esc(U.name) + '" autocomplete="nickname"></div>' +
    '<div class="panel"><label class="label" for="code">加入朋友的房間</label>' +
    '<input id="code" class="code-in" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="房號" value="' + esc(U.code) + '" autocomplete="off">' +
    '<button class="btn" data-act="join">加入房間</button></div>' +
    '<div class="panel"><div class="label">或由你當房主</div><button class="btn ghost" data-act="create">開一個新房間</button></div>';
}

function vLobby() {
  const n = V.players.length, host = isHost();
  const list = V.players.map((name, i) =>
    '<li><span class="seat">' + (i + 1) + '</span><span class="nm">' + esc(name) + '</span>' +
    (i === V.host ? '<span class="badge gold">房主</span>' : '') + (i === V.me ? '<span class="badge">你</span>' : '') +
    (host ? '<button class="ico" data-s="move" data-i="' + i + '" data-dir="-1" aria-label="往前移" ' + (i === 0 ? 'disabled' : '') + '>↑</button>' +
      '<button class="ico" data-s="move" data-i="' + i + '" data-dir="1" aria-label="往後移" ' + (i === n - 1 ? 'disabled' : '') + '>↓</button>' +
      (i !== V.me ? '<button class="ico" data-act="kick" data-i="' + i + '" aria-label="移出">' + (U.arm === 'kick' + i ? '確定' : '✕') + '</button>' : '<span class="ico" style="border:0;background:none"></span>') : '') +
    '</li>').join('');
  const status = n < 6 ? '還差 ' + (6 - n) + ' 人才能開局' : SETS[n];
  return '<div class="panel center"><div class="label">房號</div><div class="bigcode">' + esc(V.code) + '</div>' +
    '<div class="qr" id="qr" hidden></div>' +
    '<p class="muted">朋友掃 QR code，或打開這個網站輸入房號。</p>' +
    '<button class="btn ghost small" data-act="share">分享邀請連結</button></div>' +
    '<div class="panel"><div class="row"><div class="label">玩家 ' + n + ' / 8</div></div><ul class="plist">' + list + '</ul>' +
    '<p class="muted">座位順序就是發言順序（' + (host ? '房主可用 ↑↓ 依實際座位調整' : '房主會依實際座位調整') + '）。<br>' + status + '</p>' +
    (host ? '<button class="btn" data-s="start" ' + (n < 6 ? 'disabled' : '') + '>發身份，開局</button>' : '<p><span class="pulse"></span>等房主開局…</p>') + '</div>';
}

function roleCard(m) {
  let mate = '';
  if (m.mate) mate = '<p>你的隊友：<b>' + pn(m.mate.i) + '</b>（' + m.mate.role + '）</p>';
  else if (m.role === 'zg') mate = '<p class="muted">你不知道誰是隊友，隊友也不知道你。</p>';
  return '<span class="seal big">' + esc(m.name.slice(0, 1)) + '</span><h1>' + esc(m.name) + '</h1>' +
    '<div class="' + campCls(m.camp) + '">' + campName(m.camp) + '</div><p>' + esc(m.desc) + '</p>' + mate;
}

function vDeal() {
  const ready = V.ready[V.me];
  const card = U.showRole
    ? roleCard(V.mine) + '<button class="btn ghost small" data-act="hiderole">蓋起來</button>'
    : '<button class="reveal-cover" data-act="showrole">點一下查看身份<br><small>別讓旁邊的人看到螢幕</small></button>';
  return '<div class="panel center"><div class="label">你的身份</div>' + card +
    (ready ? '<p class="muted"><span class="pulse"></span>等其他人確認…</p>' : '<button class="btn" data-s="ready">我記住了</button>') + '</div>' +
    '<div class="panel"><div class="label">確認進度 ' + V.ready.filter(Boolean).length + ' / ' + V.players.length + '</div>' + progressChips(i => V.ready[i]) + '</div>';
}

function vWaitTurn() {
  const chain = V.chain;
  const chips = chain.map(i => '<span class="chip ' + (i === V.actor ? 'now' : 'done') + '">' + pn(i) + '</span>').join('<span class="muted">→</span>') +
    V.players.map((n, i) => i).filter(i => !chain.includes(i)).map(i => '<span class="chip">' + pn(i) + '</span>').join('');
  return '<div class="panel"><div class="label">第 ' + (V.round + 1) + ' 輪　行動階段　' + (chain.length - 1) + ' / ' + V.players.length + '</div>' +
    '<h2><span class="pulse"></span>' + pn(V.actor) + ' 正在行動</h2>' +
    '<div class="chips" style="align-items:center">' + chips + '</div>' +
    '<p class="muted">' + (chain.includes(V.me) ? '你本輪已經行動過了。' : '輪到你時手機會震動提醒。') + '</p></div>' +
    '<div class="panel"><div class="label">本輪四件寶物（兩真兩假）</div>' + headTiles(V.current) + '</div>' + board();
}

function vMyTurn() {
  const t = V.turn, m = V.mine;
  const others = V.players.map((n, i) => i).filter(i => i !== V.me);
  const title = '<div class="label">輪到你了　' + esc(m.name) + '</div>';
  if (t.step === 'blocked') {
    const msg = t.blocked === 'round' ? '本輪你無法鑑定寶物。' : '你被藥不然偷襲了！';
    const sub = t.blocked === 'perm' ? '姬云浮被偷襲後，整場遊戲都無法鑑定。' : t.blocked === 'attack' ? '這一次不能鑑定，也不能發動能力。' : '';
    return '<div class="panel center hot">' + title + '<span class="seal big mute">無</span><h1>' + msg + '</h1><p class="muted">' + sub + '</p>' +
      '<button class="btn" data-s="blockedok">繼續</button></div>';
  }
  if (t.step === 'pick') {
    return '<div class="panel hot">' + title + '<h2>選一件寶物鑑定' + (m.role === 'xy' ? '（第 ' + (t.results.length + 1) + ' 件，共 2 件）' : '') + '</h2>' +
      headTiles(V.current, { act: 'appraise', disabled: t.results.map(x => x.id) }) + '</div>';
  }
  if (t.step === 'result') {
    const x = t.results[t.results.length - 1];
    const seal = x.r === 'real' ? '<span class="seal big">真</span>' : x.r === 'fake' ? '<span class="seal big bronze">贗</span>' : '<span class="seal big mute">無</span>';
    const txt = x.r === 'real' ? '真品' : x.r === 'fake' ? '贗品' : '無法鑑定';
    return '<div class="panel center hot"><div class="label">' + z(x.id) + '首</div>' + seal + '<h1>' + txt + '</h1>' +
      '<p class="muted">結果已記在「我的身份與紀錄」裡。</p>' +
      (t.left > 0 ? '<button class="btn" data-s="more">再鑑定一件</button>' : '<button class="btn" data-s="after">繼續</button>') + '</div>';
  }
  if (t.step === 'ability') {
    let body = '';
    if (m.role === 'lc') {
      body = t.swap ? '<p class="muted">本輪已經發動過。</p><button class="btn" data-s="skip">繼續</button>'
        : '<h2>要發動能力嗎？</h2><p class="muted">發動後，本輪排在你後面的玩家（己方陣營與姬云浮除外）看到的真假互換。</p>' +
          '<button class="btn" data-s="swapon">發動</button><button class="btn ghost" data-s="skip">不發動</button>';
    } else if (m.role === 'yb') {
      body = '<h2>偷襲誰？</h2><p class="muted">對方下次輪到時無法鑑定或發動能力。</p>' + pickList(others, 'attack') + '<button class="btn ghost" data-s="skip">不偷襲</button>';
    } else if (m.role === 'zg') {
      body = '<h2>覆蓋哪件寶物？</h2><p class="muted">之後鑑定它的人只會看到「無法鑑定」。</p>' + headTiles(V.current, { act: 'cover', disabled: t.covered, covered: t.covered }) + '<button class="btn ghost" data-s="skip">不覆蓋</button>';
    } else if (m.role === 'fz') {
      body = '<h2>查看誰的陣營？</h2>' + pickList(others, 'viewcamp') + '<button class="btn ghost" data-s="skip">不查看</button>';
    }
    return '<div class="panel hot"><div class="label">' + esc(m.name) + '的能力</div>' + body + '</div>';
  }
  if (t.step === 'info') {
    return '<div class="panel center hot"><div class="label">查驗結果</div><h1>' + esc(t.msg) + '</h1><button class="btn" data-s="infook">繼續</button></div>';
  }
  if (t.step === 'next') {
    const rest = V.players.map((n, i) => i).filter(i => i !== V.me && !t.acted.includes(i));
    return '<div class="panel hot"><div class="label">派票</div><h2>把行動權交給誰？</h2><p class="muted">只能選本輪還沒行動的玩家。大家都看得到你派給誰。</p>' + pickList(rest, 'pass') + '</div>';
  }
  return '';
}

function vDiscuss() {
  const sp = V.speak, cur = sp.order[sp.i], mine = cur === V.me;
  const list = sp.order.map((p, k) => '<li class="' + (k < sp.i ? 'done' : k === sp.i ? 'now' : '') + '"><span class="seat">' + (k + 1) + '</span><span class="nm">' + pn(p) + '</span>' +
    (k < sp.i ? '<span class="badge">說完了</span>' : k === sp.i ? '<span class="badge gold">發言中</span>' : '') + '</li>').join('');
  return '<div class="panel' + (mine ? ' hot' : '') + '"><div class="label">發言　從尾家 ' + pn(V.last) + ' 的左手邊開始</div>' +
    '<h2>' + (mine ? '輪到你發言' : '<span class="pulse"></span>' + pn(cur) + ' 發言中') + '</h2>' +
    '<p class="muted">依序輪流發言，發言時不可被打斷或質疑。全部說完後進入投票。</p>' +
    '<ul class="plist">' + list + '</ul>' +
    (mine ? '<button class="btn" data-s="spoke">我說完了</button>' : '') +
    (isHost() && !mine ? '<button class="btn ghost" data-s="spoke">（房主）' + pn(cur) + ' 說完了，換下一位</button><button class="btn ghost" data-s="tovote">跳過剩下的發言，直接投票</button>' : '') +
    '</div>' + board();
}

function vVote() {
  const ids = V.current, chips = V.mine.chips;
  let main;
  if (!V.myBallot) {
    const d = U.draft, used = sum(d), left = chips - used, last = V.round === 2;
    const rows = ids.map((id, k) => '<div class="row"><div class="row" style="gap:12px"><span class="seal">' + z(id) + '</span><b>' + z(id) + '首</b></div>' +
      '<div class="stepper"><button data-act="vm" data-k="' + k + '" aria-label="減一票" ' + (d[k] ? '' : 'disabled') + '>－</button><output>' + d[k] + '</output>' +
      '<button data-act="vp" data-k="' + k + '" aria-label="加一票" ' + (left > 0 ? '' : 'disabled') + '>＋</button></div></div>').join('');
    main = '<div class="panel hot"><div class="label">投票　第 ' + (V.round + 1) + ' 輪</div><h2>分配你的投票籌碼</h2>' +
      '<p>你有 <b>' + chips + '</b> 枚，已分配 ' + used + '，剩 ' + left + ' 枚<span class="muted">' + (last ? '（最後一輪，要全部投完）' : '（沒用完的留到下一輪）') + '</span></p>' + rows +
      '<p class="muted">得票最高的兩件會被保護。平票時十二生肖排前面的較高（鼠最前、豬最後）。</p>' +
      '<button class="btn" data-act="vote" ' + (last && left > 0 ? 'disabled' : '') + '>' + (last && left > 0 ? '還有 ' + left + ' 枚沒投' : '送出投票') + '</button></div>';
  } else {
    main = '<div class="panel"><div class="label">已送出</div><p>' + ids.map((id, k) => z(id) + '首 ' + V.myBallot[k] + ' 票').join('、') + '</p>' +
      '<p class="muted"><span class="pulse"></span>全部人投完就會同時開票。</p><button class="btn ghost small" data-s="unvote">收回重投</button></div>';
  }
  return main + '<div class="panel"><div class="label">投票進度 ' + V.voted.length + ' / ' + V.players.length + '</div>' + progressChips(i => V.voted.includes(i)) + '</div>' + board();
}

function ballotTable(L) {
  const head = '<tr><th>玩家</th>' + L.ids.map(id => '<th class="num">' + z(id) + '</th>').join('') + '</tr>';
  const rows = V.players.map((n, i) => { const b = L.ballots[i] || [0, 0, 0, 0]; return '<tr><td>' + pn(i) + '</td>' + b.map(v => '<td class="num">' + (v || '·') + '</td>').join('') + '</tr>'; }).join('');
  const tot = '<tr><th>合計</th>' + L.totals.map(v => '<th class="num">' + v + '</th>').join('') + '</tr>';
  return '<div class="scroll"><table><thead>' + head + '</thead><tbody>' + rows + tot + '</tbody></table></div>';
}

function vReveal() {
  const L = V.plog[V.plog.length - 1];
  const rows = L.order.map((o, i) => {
    let st = '未保護';
    if (i === 0) st = '<b>受保護</b>　真偽不公開';
    if (i === 1) st = '<b>受保護</b>　公開：' + (L.top2real ? '<span class="camp-bad">真品</span>' : '<span class="camp-good">贗品</span>');
    return '<tr><td><span class="seal">' + z(o.id) + '</span></td><td class="score">' + o.v + ' 票</td><td>' + st + '</td></tr>';
  }).join('');
  const next = V.round < 2 ? '進入第 ' + (V.round + 2) + ' 輪（起始玩家：' + pn(V.last) + '）' : '結束三輪，進入結算';
  return '<div class="panel"><div class="label">第 ' + (V.round + 1) + ' 輪開票</div><h2>得票最高的兩件被保護</h2>' +
    '<div class="scroll"><table><tbody>' + rows + '</tbody></table></div>' +
    (isHost() ? '<button class="btn" data-s="next">' + next + '</button>' : '<p class="muted"><span class="pulse"></span>等房主繼續…</p>') + '</div>' +
    '<div class="panel"><div class="label">每個人的票</div>' + ballotTable(L) + '</div>' + board();
}

function vFinal() {
  const fin = V.finalists.includes(V.me);
  const prompt = { lc: '你認為誰是許願？', yb: '你認為誰是方震？' }[V.mine.role] || '你認為誰是老朝奉？';
  let main;
  if (fin && V.myGuess === null) {
    main = '<div class="panel hot"><div class="label">身份揭露　' + esc(V.mine.name) + '</div><h2>' + prompt + '</h2>' +
      '<p class="muted">送出後不能更改。</p>' + pickList(V.players.map((n, i) => i).filter(i => i !== V.me), 'guess') + '</div>';
  } else {
    main = '<div class="panel center"><div class="label">身份揭露</div>' +
      (fin ? '<h2>你指認了 ' + pn(V.myGuess) + '</h2>' : '<h2>鄭國渠不參與指認</h2>') +
      '<p class="muted"><span class="pulse"></span>等其他人指認完畢…</p></div>';
  }
  return main + '<div class="panel"><div class="label">指認進度 ' + V.guessed.length + ' / ' + V.finalists.length + '</div>' +
    '<div class="chips">' + V.finalists.map(i => '<span class="chip' + (V.guessed.includes(i) ? ' done' : '') + '">' + (V.guessed.includes(i) ? '✓ ' : '') + pn(i) + '</span>').join('') + '</div></div>';
}

function vEnd() {
  const R = V.reveal, c = R.score;
  const parts = c.parts.map(x => '<tr><td>' + esc(x.t) + '</td><td class="score">+' + x.v + '</td></tr>').join('');
  const roles = R.roles.map((r, i) => {
    const g = R.guesses[i] !== undefined ? pn(R.guesses[i]) : '—';
    return '<tr><td>' + pn(i) + (i === V.me ? '（你）' : '') + '</td><td class="' + campCls(r.camp) + '">' + esc(r.name) + '</td><td>' + (c.direct ? '—' : g) + '</td></tr>';
  }).join('');
  const prot = V.plog.map(L => '<tr><td>第 ' + (L.round + 1) + ' 輪</td><td>' + L.order.slice(0, 2).map(o => z(o.id) + (R.real[o.id] ? '（真）' : '（贗）')).join('、') + '</td></tr>').join('');
  const truth = ZODIAC.map((name, id) => '<div class="cell ' + (R.real[id] ? 'real' : 'fake') + '"><b>' + name + '</b><small>' + (R.real[id] ? '真' : '贗') + '</small></div>').join('');
  const hist = R.roles.map((r, i) => '<details><summary>' + pn(i) + '（' + esc(r.name) + '）</summary><ul class="hist">' +
    (R.hist[i].map(h => '<li>' + esc(h) + '</li>').join('') || '<li class="muted">沒有紀錄</li>') + '</ul></details>').join('');
  return '<div class="panel center"><div class="label">結算</div>' +
    (c.win ? '<span class="seal big bronze">勝</span><h1>許願陣營獲勝</h1>' : '<span class="seal big">敗</span><h1>老朝奉陣營獲勝</h1>') +
    (c.direct ? '<p>六件真品全部找回，直接獲勝。</p>' : '<p class="score">好人 ' + c.total + ' 分（需要 6 分）</p>') + '</div>' +
    '<div class="panel"><div class="label">得分</div><table><tbody>' + parts + '</tbody></table></div>' +
    '<div class="panel"><div class="label">身份與指認</div><div class="scroll"><table><thead><tr><th>玩家</th><th>身份</th><th>指認</th></tr></thead><tbody>' + roles + '</tbody></table></div></div>' +
    '<div class="panel"><div class="label">受保護的寶物</div><table><tbody>' + prot + '</tbody></table></div>' +
    '<div class="panel"><div class="label">十二獸首真相</div><div class="board">' + truth + '</div></div>' +
    '<div class="panel"><div class="label">每個人的行動紀錄</div>' + hist + '</div>' +
    (isHost() ? '<button class="btn" data-s="again">再來一局（同一群人回到房間）</button>' : '<p class="muted center">房主可以開始下一局。</p>');
}

function vInfo() {
  const m = V.mine;
  const h = m.hist.map(x => '<li>' + esc(x) + '</li>').join('') || '<li class="muted">還沒有紀錄</li>';
  return '<div class="panel center">' + roleCard(m) + '</div>' +
    '<div class="panel"><div class="label">投票籌碼</div><p>手上有 <b>' + m.chips + '</b> 枚（每輪開始時加 2 枚）</p></div>' +
    '<div class="panel"><div class="label">我的紀錄</div><ul class="hist">' + h + '</ul></div>' +
    '<div class="panel"><div class="label">換手機或瀏覽器？</div><p class="muted">用這個連結可以回到這局，<b>不要傳給別人</b>，拿到的人能看到你的身份。</p>' +
    '<button class="btn ghost small" data-act="copyrejoin">複製我的重連連結</button></div>' +
    '<button class="btn" data-act="info">關閉</button>';
}

function view() {
  if (!sess || !V) return header() + (sess ? '<p class="muted">連線中…</p>' : vHome());
  let body;
  if (U.info && V.mine) body = vInfo();
  else if (V.phase === 'lobby') body = vLobby();
  else if (V.phase === 'deal') body = vDeal();
  else if (V.phase === 'turn') body = myTurn(V) ? vMyTurn() : vWaitTurn();
  else if (V.phase === 'discuss') body = vDiscuss();
  else if (V.phase === 'vote') body = vVote();
  else if (V.phase === 'reveal') body = vReveal();
  else if (V.phase === 'final') body = vFinal();
  else body = vEnd();
  let foot;
  if (V.phase === 'lobby') foot = '<footer><span></span><button class="btn ghost small" data-act="leave">' + (U.arm === 'leave' ? '確定離開？' : '離開房間') + '</button></footer>';
  else foot = '<footer>' + (V.mine && !U.info && V.phase !== 'end' ? '<button class="btn ghost small" data-act="info">我的身份與紀錄</button>' : '<span></span>') +
    (isHost() && V.phase !== 'end' ? '<button class="btn ghost small" data-act="abort">' + (U.arm === 'abort' ? '再按一次，結束這局' : '房主：結束這局') + '</button>' : '') + '</footer>';
  return header() + body + foot;
}

let lastScreen = '';
function render(fromPoll) {
  const key = !V ? 'home' : [V.phase, V.round, V.actor, V.turn && V.turn.step, V.turn && V.turn.results.length, U.info].join('|');
  const same = key === lastScreen;
  $app.classList.toggle('still', !!fromPoll && same);
  const y = window.scrollY;
  $app.innerHTML = view();
  if (same) window.scrollTo(0, y); else window.scrollTo(0, 0);
  lastScreen = key;
  drawQr();
}

function inviteUrl() { return location.origin + '/?r=' + V.code; }
function drawQr() {
  const el = document.getElementById('qr');
  if (!el || !window.qrcode) return;
  try {
    const qr = window.qrcode(0, 'M'); qr.addData(inviteUrl()); qr.make();
    el.innerHTML = qr.createImgTag(4, 0); el.hidden = false;
  } catch (e) {}
}
window.addEventListener('load', drawQr);

async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch (e) { window.prompt('複製這個連結：', text); }
}

/* ---------- 本機動作（不經過伺服器或需要先檢查） ---------- */
const A = {
  async create() {
    const name = U.name.trim();
    if (!name) return toast('先輸入你的名字');
    try { enter(await post({ op: 'create', name })); } catch (e) { toast(e.message); }
  },
  async join() {
    const name = U.name.trim(), room = U.code.trim();
    if (!name) return toast('先輸入你的名字');
    if (!/^\d{4}$/.test(room)) return toast('房號是 4 位數字');
    try { enter(await post({ op: 'join', room, name })); } catch (e) { toast(e.message); }
  },
  resume() { sess = U.resume; U.resume = null; store.set(SKEY, sess); render(); poll(); },
  showrole() { U.showRole = true; },
  hiderole() { U.showRole = false; },
  info() { U.info = !U.info; },
  vp(d) { if (sum(U.draft) < V.mine.chips) U.draft[+d.k]++; },
  vm(d) { if (U.draft[+d.k] > 0) U.draft[+d.k]--; },
  vote() { send('vote', { votes: U.draft }); },
  kick(d) { if (U.arm === 'kick' + d.i) { U.arm = null; send('kick', { i: +d.i }); } else U.arm = 'kick' + d.i; },
  leave() { if (U.arm === 'leave') { U.arm = null; send('leave'); } else U.arm = 'leave'; },
  abort() { if (U.arm === 'abort') { U.arm = null; U.info = false; send('abort'); } else U.arm = 'abort'; },
  async share() {
    const url = inviteUrl();
    if (navigator.share) { try { await navigator.share({ title: '古董局中局', text: '來玩古董局中局！房號 ' + V.code, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    copy(url, '邀請連結已複製');
  },
  copyrejoin() { copy(location.origin + '/?r=' + sess.room + '&t=' + sess.token, '重連連結已複製，請自己保管'); }
};

$app.addEventListener('click', e => {
  const b = e.target.closest('[data-act],[data-s]');
  if (!b || b.disabled) return;
  keepAwake();
  const d = b.dataset;
  if (d.act !== 'kick' && d.act !== 'leave' && d.act !== 'abort') U.arm = null;
  if (d.s) {
    const data = {};
    if (d.i !== undefined) data.i = +d.i;
    if (d.id !== undefined) data.id = +d.id;
    if (d.dir !== undefined) data.dir = +d.dir;
    send(d.s, data);
    return;
  }
  const r = A[d.act] && A[d.act](d);
  if (!(r instanceof Promise)) render();
});
$app.addEventListener('input', e => {
  if (e.target.id === 'name') { U.name = e.target.value; store.set(NKEY, U.name); }
  if (e.target.id === 'code') { e.target.value = e.target.value.replace(/\D/g, ''); U.code = e.target.value; }
});
$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'code') A.join();
});

render();
poll();
