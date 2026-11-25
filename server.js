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
const ITEM_IDS = new Set([100, 101, 110, 111, 112, 113, 114, 115]);
const validBlock = b => Number.isInteger(b) && b >= 0 && b <= 19 && b !== WATER && b !== BEDROCK;
const validItem = b => (validBlock(b) && b !== 0) || ITEM_IDS.has(b);
const num = v => typeof v === 'number' && Number.isFinite(v);

// ---------- ワールドの保存・読み込み ----------
let seed = (Math.random() * 1e9) | 0, tod = 0.3;
const edits = new Map();   // "x,y,z" → ブロックID
let dirty = false;
try {
  const w = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  seed = w.seed; tod = w.tod || 0.3;
  for (const k in w.edits) edits.set(k, w.edits[k]);
  console.log(`ワールド読み込み: seed=${seed} 変更ブロック=${edits.size}`);
} catch (e) {
  console.log(`新しいワールドを作成: seed=${seed}`);
  dirty = true;
}
function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify({ seed, tod, edits: Object.fromEntries(edits) }));
    fs.renameSync(FILE + '.tmp', FILE);   // 書き込み途中で落ちても壊れないよう、別名で書いてから差し替える
    dirty = false;
  } catch (e) { console.error('保存失敗:', e.message); }
}
setInterval(save, 20000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { save(); process.exit(0); });

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
const players = new Map();   // id → { id, name, x, y, z, yaw, pitch, sn, ws, moved }
const items = new Map();     // id → 落ちているアイテム
let nextPlayer = 1, nextItem = 1;

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
    broadcast({ t: 'set', x, y, z, b }, p.ws);
    if (b === 0 && validItem(m.drop)) {
      spawnItem({ b: m.drop, n: 1, x: x + 0.5, y: y + 0.3, z: z + 0.5,
        vx: (Math.random() - 0.5) * 1.6, vy: 2.5, vz: (Math.random() - 0.5) * 1.6, delay: 0.4 }, p.id);
    }
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
  },
  chat(p, m) {
    const text = clean(m.text, 100);
    if (text) broadcast({ t: 'chat', name: p.name, text });
  },
  skip(p) {   // T キー: 時間を3時間進める
    tod = (tod + 0.125) % 1; dirty = true;
    broadcast({ t: 'tod', v: tod });
    broadcast({ t: 'chat', name: '', text: `${p.name} が時間を進めた` });
  },
};

wss.on('connection', ws => {
  let p = null;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (!p) {
      if (m.t !== 'join') return;
      p = { id: nextPlayer++, name: clean(m.name, 16) || 'プレイヤー', x: 0, y: -100, z: 0, yaw: 0, pitch: 0, sn: 0, ws, moved: false };
      const now = Date.now();
      sendTo(ws, {
        t: 'init', id: p.id, seed, tod,
        edits: [...edits].map(([k, b]) => { const [x, y, z] = k.split(',').map(Number); return [x, y, z, b]; }),
        players: [...players.values()].map(q => ({ id: q.id, name: q.name, x: q.x, y: q.y, z: q.z, yaw: q.yaw, pitch: q.pitch, sn: q.sn })),
        items: [...items.values()].map(({ born, ...it }) => ({ ...it, age: (now - born) / 1000 })),
      });
      players.set(p.id, p);
      broadcast({ t: 'join', id: p.id, name: p.name }, ws);
      console.log(`参加: ${p.name} (${players.size}人)`);
      return;
    }
    const h = handlers[m.t];
    if (h) h(p, m);
  });
  ws.on('close', () => {
    if (!p) return;
    players.delete(p.id);
    broadcast({ t: 'leave', id: p.id });
    console.log(`退出: ${p.name} (${players.size}人)`);
  });
  ws.on('error', () => {});
});

// 位置は 1秒に10回、動いた人の分だけまとめて配る
setInterval(() => {
  const l = [];
  for (const p of players.values()) if (p.moved) { p.moved = false; l.push([p.id, p.x, p.y, p.z, p.yaw, p.pitch, p.sn]); }
  if (l.length) broadcast({ t: 'ps', l });
}, 100);
// 時刻を進めて、5秒ごとに全員の時計を合わせる。古いアイテムも消す
setInterval(() => {
  tod = (tod + 5 / DAYLEN) % 1; dirty = true;
  broadcast({ t: 'tod', v: tod });
  const now = Date.now();
  for (const it of items.values()) if (now - it.born > ITEM_TTL * 1000) { items.delete(it.id); broadcast({ t: 'rm', id: it.id }); }
}, 5000);

server.listen(PORT, () => console.log(`起動: ポート ${PORT}`));
