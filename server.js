// BlockCraft サーバー
// 役割: 画面(public/)の配信と、WebSocket での同期。
// 地形そのものは持たない。全員に同じシード値を配り、各自のブラウザが同じ地形を生成する。
// サーバーが持つのは「シード値・プレイヤーが変えたブロック・時刻・落ちているアイテム・各プレイヤーの位置」だけ。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');   // Railway では Volume を割り当てたパスを指定する
const FILE = path.join(DATA_DIR, 'world.json');
const DAYLEN = 600;        // 1日の秒数（クライアントと同じ値）
const H = 64;              // ワールドの高さ
const ITEM_TTL = 300;      // 落ちているアイテムが消えるまでの秒数
const WATER = 5, BEDROCK = 9;
const WHEAT0 = 25, WHEAT3 = 28;
const FAST = !!process.env.FAST;   // テスト用: モブの湧きと作物の成長を速くする
const TORCH = 29;          // 29=床の松明、30〜33=壁の松明（向き違い）。アイテムとしては 29 だけ
const WOOL = 34, SAPLING = 44, CHEST = 45, CAKE0 = 46, MAX_BLOCK = 57;   // 45=チェスト 46〜49=ケーキ 50〜57=にんじん・じゃがいもの成長段階   // 34〜44: 羊毛・ベッド・鉱石ブロック・石レンガ・ガラス・粘土・レンガ・苗木
const ITEM_IDS = new Set([100, 101, 102, 103, 104, 105, 106, 107, 108, 120, 121, 122, 123, 124, 125, 126, TORCH]);
for (let tier = 0; tier < 5; tier++) for (let type = 0; type < 5; type++) ITEM_IDS.add(200 + tier * 10 + type);   // ツール
for (let b = 34; b <= CAKE0; b++) ITEM_IDS.add(b);
for (let i = 130; i <= 140; i++) ITEM_IDS.add(i);                                                               // 時計・ハサミ・バケツ・リンゴ・盾・卵・にんじん・じゃがいも
for (let tier = 2; tier < 5; tier++) for (let part = 0; part < 4; part++) ITEM_IDS.add(300 + tier * 10 + part);   // 防具
const validBlock = b => Number.isInteger(b) && b >= 0 && b <= MAX_BLOCK && b !== BEDROCK;   // 水(5)はバケツで置ける
const validItem = b => (validBlock(b) && b !== 0 && b !== WATER && b < 24) || ITEM_IDS.has(b);
const num = v => typeof v === 'number' && Number.isFinite(v);

// ---------- ワールドの保存・読み込み ----------
let seed = process.env.SEED ? Number(process.env.SEED) | 0 : (Math.random() * 1e9) | 0, tod = process.env.TOD ? Number(process.env.TOD) : 0.3;   // SEED を指定すると新規ワールドの地形を固定できる
const edits = new Map();   // "x,y,z" → ブロックID
const chests = new Map();  // "x,y,z" → { slots: 27枠の中身, user: 開いているプレイヤーID(0=誰も開いていない) }
let dirty = false;
try {
  const w = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  seed = w.seed; tod = w.tod || 0.3;
  for (const k in w.edits) edits.set(k, w.edits[k]);
  for (const k in (w.chests || {})) chests.set(k, { slots: w.chests[k], user: 0 });
  console.log(`ワールド読み込み: seed=${seed} 変更ブロック=${edits.size}`);
} catch (e) {
  console.log(`新しいワールドを作成: seed=${seed}`);
  dirty = true;
}
function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify({ seed, tod, edits: Object.fromEntries(edits), chests: Object.fromEntries([...chests].map(([k, c]) => [k, c.slots])) }));
    fs.renameSync(FILE + '.tmp', FILE);   // 書き込み途中で落ちても壊れないよう、別名で書いてから差し替える
    dirty = false;
  } catch (e) { console.error('保存失敗:', e.message); }
}
// 変更があれば3秒ごとに保存する。再デプロイ時は新しいサーバーが先にファイルを読み込み、
// その後で古いサーバーが最後の保存をするため、最後の保存は新しい方に届かない。間隔を短くして消える分を最大3秒にする
setInterval(save, 3000);
// 再デプロイ時は SIGTERM が届く。最後に保存してから終わる
// （npm start 経由だと node まで届かないことがあるので、railway.json で node server.js を直接起動している）
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { save(); console.log(`終了(${sig}): ワールドを保存した`); process.exit(0); });

// ---------- 画面の配信 ----------
const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); res.end('error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

// ---------- 同期 ----------
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const crops = new Set();     // 育ち途中の小麦がある場所（"x,y,z"）
const saplings = new Set();  // 苗木がある場所
for (const [k, b] of edits) { if ((b >= WHEAT0 && b < WHEAT3) || (b >= 50 && b <= 52) || (b >= 54 && b <= 56)) crops.add(k); if (b === SAPLING) saplings.add(k); }
const players = new Map();   // id → { id, name, x, y, z, yaw, pitch, sn, ws, moved }
const items = new Map();     // id → 落ちているアイテム
const mobs = new Map();      // id → { id, kind, x, y, z, yaw, hp, owner }
let nextPlayer = 1, nextItem = 1, nextMob = 1;
// モブの体力と、倒した時に落とす物 [アイテム, 最小, 最大]
const MOB_DEF = {
  zombie: { hp: 20, hostile: true, drop: [126, 0, 1], rare: [138, 139] },   // rare: 15% で代わりに落とす物（にんじん・じゃがいも）
  pig: { hp: 10, drop: [120, 1, 2] },
  cow: { hp: 10, drop: [122, 1, 2] },
  chicken: { hp: 4, drop: [124, 1, 1] },
  sheep: { hp: 8, drop: [WOOL, 1, 1] },
};
const ANIMALS = ['pig', 'cow', 'chicken', 'sheep'];
const isNight = () => tod > 0.76 || tod < 0.24;
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const clampK = v => num(v) ? Math.max(-8, Math.min(8, v)) : 0;

const sendTo = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function broadcast(o, except) {
  const s = JSON.stringify(o);
  for (const p of players.values()) if (p.ws !== except && p.ws.readyState === 1) p.ws.send(s);
}
function spawnItem(it, by) {
  const item = { id: nextItem++, b: it.b, n: it.n, x: it.x, y: it.y, z: it.z, vx: it.vx, vy: it.vy, vz: it.vz, delay: it.delay, by, born: Date.now() };
  if (num(it.d)) item.d = it.d;
  items.set(item.id, item);
  const { born, ...pub } = item;
  broadcast({ t: 'item', it: pub });
}
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

// 育ち途中の作物か（小麦 25〜27、にんじん 50〜52、じゃがいも 54〜56。それぞれ次の番号が1段階先）
const growing = b => (b >= WHEAT0 && b < WHEAT3) || (b >= 50 && b <= 52) || (b >= 54 && b <= 56);
// 作物・苗木の場所を覚えておく（成長させる対象）
function track(key, b) {
  if (growing(b)) crops.add(key); else crops.delete(key);
  if (b === SAPLING) saplings.add(key); else saplings.delete(key);
}
// 寝ている人を数えて、全員寝ていたら朝にする
function checkSleep() {
  const ps = [...players.values()].filter(p => p.y > -50);
  if (!ps.length || !ps.every(p => p.sleep)) return;
  tod = 0.26; dirty = true;
  for (const p of ps) p.sleep = false;
  broadcast({ t: 'tod', v: tod });
  broadcast({ t: 'wake', msg: '朝になった' });
}
const handlers = {
  // ブロックの破壊・設置。was は「変える前に何があったか」。
  // 2人が同時に同じブロックを壊した時に、アイテムが2個出ないよう先着1人だけ通す。
  set(p, m) {
    const { x, y, z, b, was } = m;
    if (![x, y, z].every(Number.isInteger) || y < 1 || y >= H || !validBlock(b)) return;
    const key = x + ',' + y + ',' + z, cur = edits.get(key);
    if (cur !== undefined && cur !== was) {            // すでに他の人が変えていた → 正しい状態を送り返す
      sendTo(p.ws, { t: 'set', x, y, z, b: cur });
      if (b !== 0) sendTo(p.ws, { t: 'give', b, n: 1 });   // 置こうとしたブロックは返す
      return;
    }
    edits.set(key, b); dirty = true;
    track(key, b);
    broadcast({ t: 'set', x, y, z, b }, p.ws);
    const ch = chests.get(key);
    if (ch && b !== CHEST) {   // チェストが壊された → 中身をその場に落とす
      chests.delete(key);
      const u = players.get(ch.user);
      if (u) sendTo(u.ws, { t: 'cbusy' });
      for (const st of ch.slots) if (st) spawnItem({ b: st.b, n: st.n, d: st.d, x: x + 0.5, y: y + 0.3, z: z + 0.5,
        vx: (Math.random() - 0.5) * 2, vy: 2.5, vz: (Math.random() - 0.5) * 2, delay: 0.4 }, p.id);
    }
    if (b === 0 && Array.isArray(m.drop)) {   // 壊した時のドロップ（小麦は 小麦＋種 のように複数ある）
      for (const d of m.drop.slice(0, 4)) {
        if (validItem(d)) spawnItem({ b: d, n: 1, x: x + 0.5, y: y + 0.3, z: z + 0.5,
          vx: (Math.random() - 0.5) * 1.6, vy: 2.5, vz: (Math.random() - 0.5) * 1.6, delay: 0.4 }, p.id);
      }
    }
  },
  // まとめてブロックを変える（苗木が木に育つ時）。l は [x, y, z, 新しいブロック, 元のブロック] の並び。ドロップは出ない
  sets(p, m) {
    if (!Array.isArray(m.l)) return;
    const ok = [];
    for (const e of m.l.slice(0, 100)) {
      if (!Array.isArray(e)) continue;
      const [x, y, z, b, was] = e;
      if (![x, y, z].every(Number.isInteger) || y < 1 || y >= H || !validBlock(b) || Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) continue;
      const key = x + ',' + y + ',' + z, cur = edits.get(key);
      if (cur !== undefined && cur !== was) { sendTo(p.ws, { t: 'set', x, y, z, b: cur }); continue; }
      edits.set(key, b); dirty = true; track(key, b);
      ok.push([x, y, z, b]);
    }
    if (ok.length) broadcast({ t: 'sets', l: ok }, p.ws);
  },
  // ---- チェスト ----
  // 中身はサーバーが持つ。同時に開けるのは1人だけ（2人が同時にいじって物が増えたり消えたりしないように）
  copen(p, m) {
    const { x, y, z } = m;
    if (![x, y, z].every(Number.isInteger)) return;
    const key = x + ',' + y + ',' + z;
    if (edits.get(key) !== CHEST || (p.x - x) ** 2 + (p.z - z) ** 2 > 100) return;
    let ch = chests.get(key);
    if (!ch) { ch = { slots: Array(27).fill(null), user: 0 }; chests.set(key, ch); }
    if (ch.user && ch.user !== p.id && players.has(ch.user)) { sendTo(p.ws, { t: 'cbusy' }); return; }
    for (const c of chests.values()) if (c.user === p.id) c.user = 0;   // 前に開いていた物は閉じた扱い
    ch.user = p.id;
    sendTo(p.ws, { t: 'copen', key, slots: ch.slots });
  },
  // 開いている人から、中身が変わるたびに全体が送られてくる
  cput(p, m) {
    const ch = chests.get(m.key);
    if (!ch || ch.user !== p.id || !Array.isArray(m.slots) || m.slots.length !== 27) return;
    const out = [];
    for (const st of m.slots) {
      if (st == null) { out.push(null); continue; }
      if (typeof st !== 'object' || !validItem(st.b) || !Number.isInteger(st.n) || st.n < 1 || st.n > 64) return;   // おかしな中身は丸ごと受け付けない
      const o = { b: st.b, n: st.n };
      if (num(st.d)) o.d = st.d;
      out.push(o);
    }
    ch.slots = out; dirty = true;
  },
  cclose(p, m) { const ch = chests.get(m.key); if (ch && ch.user === p.id) ch.user = 0; },
  // ベッドに入った・出た
  sleep(p, m) {
    if (m.v && !isNight()) { sendTo(p.ws, { t: 'wake', msg: '寝られるのは夜だけ' }); return; }
    if (!!m.v === !!p.sleep) return;
    p.sleep = !!m.v;
    if (p.sleep) {
      const ps = [...players.values()].filter(q => q.y > -50);
      broadcast({ t: 'chat', name: '', text: `${p.name} がベッドに入った（${ps.filter(q => q.sleep).length}/${ps.length}人）` });
      checkSleep();
    }
  },
  // 羊の毛を刈る（倒さずに羊毛が1〜3個取れる。毛は90秒ほどで生えそろう）
  shear(p, m) {
    const mob = mobs.get(m.id);
    if (!mob || mob.kind !== 'sheep' || mob.sheared || dist2(p, mob) > 36) return;
    mob.sheared = true; mob.shearAt = Date.now();
    broadcast({ t: 'mshear', id: mob.id, v: 1 });
    spawnItem({ b: WOOL, n: 1 + Math.floor(Math.random() * 3), x: mob.x, y: mob.y + 0.6, z: mob.z, vx: 0, vy: 2.5, vz: 0, delay: 0.4 }, p.id);
  },
  // アイテムを捨てる
  drop(p, m) {
    if (!validItem(m.b) || !Number.isInteger(m.n) || m.n < 1 || m.n > 64) return;
    if (![m.x, m.y, m.z, m.vx, m.vy, m.vz].every(num)) return;
    spawnItem({ b: m.b, n: m.n, d: m.d, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz, delay: 1.5 }, p.id);
  },
  // アイテムを拾う（先に届いた1人だけがもらえる）
  pick(p, m) {
    const it = items.get(m.id);
    if (!it) return;
    items.delete(m.id);
    broadcast({ t: 'rm', id: m.id });
    sendTo(p.ws, { t: 'give', b: it.b, n: it.n, d: it.d });
  },
  // アイテムが地面に落ち着いた位置（後から入った人にも正しい場所で見せるため）
  rest(p, m) {
    const it = items.get(m.id);
    if (!it || it.by !== p.id || ![m.x, m.y, m.z].every(num)) return;
    it.x = m.x; it.y = m.y; it.z = m.z; it.vx = it.vy = it.vz = 0;
  },
  pos(p, m) {
    if (![m.x, m.y, m.z, m.yaw, m.pitch].every(num)) return;
    p.x = m.x; p.y = m.y; p.z = m.z; p.yaw = m.yaw; p.pitch = m.pitch; p.sn = m.sn ? 1 : 0; p.moved = true;
    if (typeof m.eq === 'string' && /^[0-4]{4}$/.test(m.eq)) p.eq = m.eq;   // 着ている防具（他の人に見せる用）
  },
  chat(p, m) {
    const text = clean(m.text, 100);
    if (text) broadcast({ t: 'chat', name: p.name, text });
  },
  // ---- 戦闘 ----
  // プレイヤーを殴った → 殴られた本人のブラウザに伝える（体力は各自のブラウザが持っている）
  hit(p, m) {
    const q = players.get(m.id);
    if (!q || q === p || !num(m.dmg) || dist2(p, q) > 36) return;
    sendTo(q.ws, { t: 'hurt', dmg: Math.max(1, Math.min(12, Math.floor(m.dmg))), kx: clampK(m.kx), kz: clampK(m.kz), cause: p.name });
  },
  // モブを殴った → 体力はサーバーが持つ
  mhit(p, m) {
    const mob = mobs.get(m.id);
    if (!mob || !num(m.dmg)) return;
    mob.hp -= Math.max(1, Math.min(12, Math.floor(m.dmg)));
    if (mob.hp > 0) { broadcast({ t: 'mhurt', id: mob.id, kx: clampK(m.kx), kz: clampK(m.kz) }); return; }
    mobs.delete(mob.id);
    broadcast({ t: 'mrm', id: mob.id });
    const def = MOB_DEF[mob.kind], [item, lo, hi] = def.drop, n = lo + Math.floor(Math.random() * (hi - lo + 1));
    if (def.rare && Math.random() < 0.15) spawnItem({ b: def.rare[Math.floor(Math.random() * def.rare.length)], n: 1, x: mob.x, y: mob.y + 0.3, z: mob.z, vx: 0, vy: 2.5, vz: 0, delay: 0.4 }, p.id);
    else if (n > 0) spawnItem({ b: item, n, x: mob.x, y: mob.y + 0.3, z: mob.z, vx: 0, vy: 2.5, vz: 0, delay: 0.4 }, p.id);
  },
  // ゾンビが誰かを殴った（ゾンビを動かしているブラウザからの報告）
  mattack(p, m) {
    const mob = mobs.get(m.id), q = players.get(m.target);
    if (!mob || mob.owner !== p.id || !MOB_DEF[mob.kind].hostile || !q || dist2(mob, q) > 16) return;
    const l = Math.hypot(q.x - mob.x, q.z - mob.z) || 1;
    sendTo(q.ws, { t: 'hurt', dmg: 3, kx: (q.x - mob.x) / l * 5, kz: (q.z - mob.z) / l * 5, cause: 'ゾンビ' });
  },
  died(p, m) {
    const cause = clean(m.cause, 20);
    broadcast({ t: 'chat', name: '', text: cause ? `${p.name} が倒れた（${cause}）` : `${p.name} が倒れた` });
  },
  // ---- モブ ----
  // 「近くに湧かせて」と頼まれたブラウザが、地形を見て決めた場所を返してくる
  spawn(p, m) {
    if (!MOB_DEF[m.kind] || ![m.x, m.y, m.z].every(num) || dist2(p, m) > 64 * 64 || mobs.size >= 80) return;
    const mob = { id: nextMob++, kind: m.kind, x: m.x, y: m.y, z: m.z, yaw: 0, hp: MOB_DEF[m.kind].hp, owner: p.id };
    mobs.set(mob.id, mob);
    broadcast({ t: 'mob', m: mob });
  },
  // 担当しているモブの現在位置
  mobs(p, m) {
    if (!Array.isArray(m.l)) return;
    for (const e of m.l.slice(0, 80)) {
      const mob = mobs.get(e[0]);
      if (!mob || mob.owner !== p.id || !e.slice(1, 5).every(num)) continue;
      mob.x = e[1]; mob.y = e[2]; mob.z = e[3]; mob.yaw = e[4]; mob.moved = true;
    }
  },
};

// ---------- 接続の管理（連打制限・二重ログイン・接続確認） ----------
// 1人あたり・種類ごとの上限 [1秒に何回, まとめて何回まで]。超えた分は黙って捨てる。
// 普通に遊んでいて届く回数よりかなり多めにしてある（改造したブラウザからの連打・アイテム湧かせを防ぐ用）。
// チャットは制限しない。ここに無い種類は DEFAULT_RATE。新しい種類を足して回数が多いならここにも足すこと。
const RATE = {
  pos: [20, 40], mobs: [20, 40], set: [60, 120], pick: [30, 60], rest: [10, 30], drop: [10, 40],
  hit: [8, 16], mhit: [8, 16], mattack: [10, 20], spawn: [2, 10], died: [1, 3],
  sets: [2, 6], sleep: [2, 6], shear: [4, 8], copen: [4, 8], cput: [30, 60], cclose: [4, 8],
};
const DEFAULT_RATE = [30, 60];
const WORLD_LIMIT = 500000;   // これより遠い座標のブロック変更は受け付けない（クライアントのチャンク番号が壊れる範囲）
function allow(p, m) {
  if (players.get(p.id) !== p) return false;   // 二重ログインで切られた側の残りのメッセージ
  if (m.t === 'chat') return true;
  if (m.t === 'set' && !(Math.abs(m.x) <= WORLD_LIMIT && Math.abs(m.z) <= WORLD_LIMIT)) return false;
  const [rate, burst] = RATE[m.t] || DEFAULT_RATE, now = Date.now();
  const b = p.bucket || (p.bucket = {}), s = b[m.t] || (b[m.t] = { tk: burst, at: now });
  s.tk = Math.min(burst, s.tk + (now - s.at) / 1000 * rate); s.at = now;
  if (s.tk < 1) return false;
  s.tk--;
  return true;
}
// 同じブラウザ（cid が同じ）から同じ名前でまた入ってきたら、古い方を切る（別タブ・回線断で残った接続）。
// 同じブラウザでも名前が違えば別プレイヤー扱い（タブ2つで2人プレイの確認ができるように）。
// 別の人と名前がかぶったら「名前(2)」にして区別する。
function admit(name, cid) {
  if (cid) for (const q of players.values()) if (q.cid === cid && q.base === name) {
    players.delete(q.id);
    broadcast({ t: 'leave', id: q.id });
    console.log(`二重ログインのため切断: ${q.name}`);
    q.ws.close(4000, 'duplicate');   // 4000 を受け取ったブラウザは自動で入り直さない
  }
  let n = name, k = 2;
  while ([...players.values()].some(q => q.name === n)) n = `${name}(${k++})`;
  return n;
}
// 接続確認: 20秒ごとに ping を送り、次の回までに返事が無い接続は切る
// （スマホのスリープや回線断で、いない人がずっと立ったままになるのを防ぐ）
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 20000);

wss.on('connection', ws => {
  let p = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (!p) {
      if (m.t !== 'join') return;
      const cid = clean(m.cid, 40), base = clean(m.name, 16) || 'プレイヤー';
      p = { id: nextPlayer++, name: admit(base, cid), base, cid, x: 0, y: -100, z: 0, yaw: 0, pitch: 0, sn: 0, eq: '0000', sleep: false, ws, moved: false };
      const now = Date.now();
      sendTo(ws, {
        t: 'init', id: p.id, seed, tod,
        edits: [...edits].map(([k, b]) => { const [x, y, z] = k.split(',').map(Number); return [x, y, z, b]; }),
        players: [...players.values()].map(q => ({ id: q.id, name: q.name, x: q.x, y: q.y, z: q.z, yaw: q.yaw, pitch: q.pitch, sn: q.sn, eq: q.eq })),
        items: [...items.values()].map(({ born, ...it }) => ({ ...it, age: (now - born) / 1000 })),
        mobs: [...mobs.values()].map(({ moved, shearAt, ...mb }) => mb),
      });
      players.set(p.id, p);
      broadcast({ t: 'join', id: p.id, name: p.name }, ws);
      console.log(`参加: ${p.name} (${players.size}人)`);
      return;
    }
    const h = handlers[m.t];
    if (h && allow(p, m)) h(p, m);
  });
  ws.on('close', () => {
    if (!p || players.get(p.id) !== p) return;   // 二重ログインで切った側は admit で退出済み
    players.delete(p.id);
    for (const c of chests.values()) if (c.user === p.id) c.user = 0;   // 開いたまま切断したチェストを解放
    broadcast({ t: 'leave', id: p.id });
    if (!players.size) mobs.clear();   // 誰もいなくなったらモブは消す
    else checkSleep();                 // 起きていた人が抜けて、残り全員が寝ている場合
    console.log(`退出: ${p.name} (${players.size}人)`);
  });
  ws.on('error', () => {});
});

// 位置は 1秒に10回、動いた人の分だけまとめて配る
setInterval(() => {
  const l = [];
  for (const p of players.values()) if (p.moved) { p.moved = false; l.push([p.id, p.x, p.y, p.z, p.yaw, p.pitch, p.sn, p.eq]); }
  if (l.length) broadcast({ t: 'ps', l });
  const ml = [];
  for (const m of mobs.values()) if (m.moved) { m.moved = false; ml.push([m.id, m.x, m.y, m.z, m.yaw]); }
  if (ml.length) broadcast({ t: 'ms', l: ml });
}, 100);
// モブの管理: 担当の割り当て、湧かせる依頼、朝になったらゾンビを消す
setInterval(() => {
  const ps = [...players.values()].filter(p => p.y > -50);
  const night = isNight();
  for (const m of mobs.values()) {
    let near = null, nd = Infinity;
    for (const p of ps) { const d = dist2(m, p); if (d < nd) { nd = d; near = p; } }
    const gone = !near || nd > 96 * 96 || (!night && MOB_DEF[m.kind].hostile && Math.random() < 0.4);   // 誰もいない・朝のゾンビ
    if (gone) { mobs.delete(m.id); broadcast({ t: 'mrm', id: m.id }); continue; }
    if (m.sheared && Date.now() - m.shearAt > (FAST ? 2000 : 90000)) { m.sheared = false; broadcast({ t: 'mshear', id: m.id, v: 0 }); }   // 羊の毛が生えそろう
    if (m.kind === 'chicken' && Math.random() < (FAST ? 0.5 : 0.02)) spawnItem({ b: 137, n: 1, x: m.x, y: m.y + 0.2, z: m.z, vx: 0, vy: 1, vz: 0, delay: 0.4 }, 0);   // 鶏が卵を産む（1羽あたり平均2分半に1個）
    const owner = players.get(m.owner);
    if (!owner || dist2(m, owner) > nd + 24 * 24) { m.owner = near.id; broadcast({ t: 'mown', id: m.id, owner: near.id }); }   // 一番近い人が動かす
  }
  if (mobs.size >= 80) return;
  for (const p of ps) {
    let z = 0, a = 0;
    for (const m of mobs.values()) if (dist2(m, p) < 64 * 64) { if (MOB_DEF[m.kind].hostile) z++; else a++; }
    if (night && z < 5) sendTo(p.ws, { t: 'wantspawn', kind: 'zombie' });
    else if (!night && a < 6) sendTo(p.ws, { t: 'wantspawn', kind: ANIMALS[Math.floor(Math.random() * ANIMALS.length)] });
  }
}, FAST ? 300 : 3000);
// 作物: 育ち途中の小麦を、ときどき1段階進める（植えてから収穫までおよそ4分）
setInterval(() => {
  for (const key of crops) {
    if (Math.random() > (FAST ? 1 : 0.06)) continue;
    const b = edits.get(key) + 1;
    edits.set(key, b); dirty = true;
    if (!growing(b)) crops.delete(key);
    const [x, y, z] = key.split(',').map(Number);
    broadcast({ t: 'set', x, y, z, b });
  }
}, FAST ? 300 : 5000);
// 苗木: ときどき、オンラインの誰か1人に「この苗木を木にして」と頼む（平均3分ほど）。
// サーバーは地形を知らないので、周りの空きを確かめて木を組み立てるのは頼まれたブラウザ。sets で結果が返ってくる
setInterval(() => {
  const ps = [...players.values()].filter(p => p.y > -50);
  if (!ps.length) return;
  for (const key of saplings) {
    if (edits.get(key) !== SAPLING) { saplings.delete(key); continue; }
    if (Math.random() > (FAST ? 1 : 0.03)) continue;
    const [x, y, z] = key.split(',').map(Number);
    let near = ps[0], nd = Infinity;
    for (const p of ps) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < nd) { nd = d; near = p; } }
    sendTo(near.ws, { t: 'grow', x, y, z });
  }
  if (!isNight()) for (const p of players.values()) if (p.sleep) { p.sleep = false; sendTo(p.ws, { t: 'wake' }); }   // 朝になったら起こす
}, FAST ? 300 : 5000);
// 時刻を進めて、5秒ごとに全員の時計を合わせる。古いアイテムも消す
setInterval(() => {
  tod = (tod + 5 / DAYLEN) % 1; dirty = true;
  broadcast({ t: 'tod', v: tod });
  const now = Date.now();
  for (const it of items.values()) if (now - it.born > ITEM_TTL * 1000) { items.delete(it.id); broadcast({ t: 'rm', id: it.id }); }
}, 5000);

server.listen(PORT, () => console.log(`起動: ポート ${PORT}`));
