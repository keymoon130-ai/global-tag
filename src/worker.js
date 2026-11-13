// 글로벌 술래잡기 — Cloudflare Worker + Durable Object 서버
// 방 하나 = Durable Object 하나. 모든 판정(거리, 이탈, 승리)은 서버가 실제 위치로 계산해요.
import { DurableObject } from 'cloudflare:workers';
import { makeVapidKeys, sendPush } from './push.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 20;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/create' && req.method === 'POST') {
      for (let i = 0; i < 10; i++) {
        let code = '';
        for (let k = 0; k < 4; k++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const r = await stub.fetch('https://room/init?code=' + code, { method: 'POST' });
        if (r.ok) return Response.json({ code });
      }
      return Response.json({ error: '방을 만들지 못했어요. 다시 시도해 주세요.' }, { status: 500 });
    }
    if (url.pathname === '/api/vapid') {
      const r = await env.ROOM.get(env.ROOM.idFromName('__vapid__')).fetch('https://room/vapid');
      const k = await r.json();
      return Response.json({ pub: k.pub });
    }
    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{4})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  }
};

// ---------------- 기본 설정 ----------------
const DEFAULTS = {
  mode: 'tag', chaserCount: 1, timeLimit: 900, hideTime: 60, winMode: 'all', winN: 3,
  revealC2R: 'interval', revealC2RSec: 30, revealR2C: 'hidden', revealR2CSec: 30, teamSee: true,
  catchDist: 20, boundaryAllow: 60, disconnectAllow: 60, transfer: false, transferCountdown: 10,
  rescueHold: 3, jailRadius: 15,
  photoOn: false, photoEvery: 600, photoDeadline: 90, photoSenders: 'runners', photoViewers: 'chasers'
};
const NUM_LIMITS = {
  chaserCount: [1, 10], timeLimit: [60, 7200], hideTime: [0, 1800], winN: [1, 20], revealC2RSec: [3, 600], revealR2CSec: [3, 600],
  catchDist: [3, 200], boundaryAllow: [5, 600], disconnectAllow: [10, 600], transferCountdown: [0, 120], rescueHold: [1, 30],
  jailRadius: [5, 100], photoEvery: [60, 3600], photoDeadline: [15, 600]
};
const ENUMS = {
  mode: ['tag', 'hide', 'cops', 'zombie'], winMode: ['all', 'n'], revealC2R: ['hidden', 'interval', 'always'],
  revealR2C: ['hidden', 'interval', 'always'], photoSenders: ['runners', 'all'], photoViewers: ['chasers', 'all']
};
const BOOLS = ['teamSee', 'transfer', 'photoOn'];
const TN = { tag: ['술래', '도망자'], hide: ['술래', '숨는 사람'], cops: ['경찰', '도둑'], zombie: ['좀비', '생존자'] };

// ---------------- 도우미 ----------------
function distM(a, b) {
  if (a == null || b == null || a.lat == null || b.lat == null) return Infinity;
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function inPoly(pt, poly) {
  if (!poly || poly.length < 3) return true;
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
    if (((yi > pt.lat) !== (yj > pt.lat)) && (pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function cleanName(s) { return String(s || '').replace(/[<>&"]/g, '').trim().slice(0, 12) || '이름없음'; }
function hexArea(c, r) {
  const pts = [], mLat = 1 / 111320, mLng = 1 / (111320 * Math.cos(c.lat * Math.PI / 180));
  for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i + Math.PI / 6; pts.push([c.lat + Math.sin(a) * r * mLat, c.lng + Math.cos(a) * r * mLng]); }
  return pts;
}

function newGame(code) {
  return {
    code, phase: 'lobby', players: [], settings: { ...DEFAULTS }, area: [], jails: [], reports: [],
    catchCount: 0, winner: null, winReason: '', hideEndsAt: 0, endsAt: 0,
    snap: { C2R: { at: 0, pos: {} }, R2C: { at: 0, pos: {} } }, nextPhotoAt: 0, seq: 0, album: [], touched: Date.now()
  };
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sockets = new Map(); // ws -> playerId
    this.g = null;
    this.photos = {};
    this.timer = null;
    this.dirty = false;
    this.lastSave = 0;
    ctx.blockConcurrencyWhile(async () => { this.g = (await ctx.storage.get('g')) || null; });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/vapid') {
      let k = await this.ctx.storage.get('vapid');
      if (!k) { k = await makeVapidKeys(); await this.ctx.storage.put('vapid', k); }
      return Response.json(k);
    }
    if (url.pathname === '/init') {
      const busy = this.g && this.g.players.length && (Date.now() - this.g.touched) < 3 * 3600 * 1000;
      if (busy) return new Response('busy', { status: 409 });
      this.g = newGame(url.searchParams.get('code'));
      this.photos = {};
      await this.ctx.storage.put('g', this.g);
      return new Response('ok');
    }
    this.origin = url.origin;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const send = (o) => { try { server.send(JSON.stringify(o)); } catch (e) {} };
    if (!this.g) {
      send({ type: 'error', code: 'noroom', text: '방을 찾을 수 없어요. 방 코드를 확인해 주세요.' });
      server.close(4004, 'noroom');
      return new Response(null, { status: 101, webSocket: client });
    }
    const g = this.g;
    const token = (url.searchParams.get('token') || '').slice(0, 64);
    const name = cleanName(url.searchParams.get('name'));
    if (!token) { send({ type: 'error', code: 'bad', text: '잘못된 접속이에요.' }); server.close(4000, 'bad'); return new Response(null, { status: 101, webSocket: client }); }
    let p = g.players.find(x => x.token === token);
    // 같은 닉네임의 끊긴 사람이 있으면 이어받아요 (아이폰 홈 화면 앱으로 다시 들어온 경우 등)
    if (!p) { const same = g.players.find(x => x.name === name && !x.connected); if (same) { same.token = token; p = same; } }
    if (!p) {
      if (g.players.length >= MAX_PLAYERS) { send({ type: 'error', code: 'full', text: '방이 가득 찼어요 (최대 ' + MAX_PLAYERS + '명).' }); server.close(4001, 'full'); return new Response(null, { status: 101, webSocket: client }); }
      p = this.newPlayer(token, name);
      if (g.phase !== 'lobby') { p.state = 'out'; p.outReason = '게임 중간에 들어와서 관전 중이에요'; }
      g.players.push(p);
      this.toastAll(p.name + '님이 들어왔어요', p.id);
    } else {
      p.name = name;
      if (!p.connected && g.phase === 'playing') { this.toast(p, '복귀했어요 · 그대로 이어서 해요'); this.toastAll(p.name + '님이 다시 연결됐어요', p.id); }
    }
    if (!g.players.some(x => x.host)) p.host = true;
    for (const [ws, pid] of this.sockets) if (pid === p.id) { try { ws.close(4002, 'replaced'); } catch (e) {} this.sockets.delete(ws); }
    this.sockets.set(server, p.id);
    p.connected = true; p.away = false; p.discAt = null; p.publicByDisc = false; p.left = false;
    server.addEventListener('message', (e) => this.onMessage(server, e.data));
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));
    this.ensureTimer();
    this.changed();
    return new Response(null, { status: 101, webSocket: client });
  }

  newPlayer(token, name) {
    return {
      id: 'p' + (++this.g.seq), token, name, host: false, role: 'runner', state: 'alive', wish: false, checked: false,
      lat: null, lng: null, acc: null, known: null, lastPosAt: 0, connected: true, away: false, discAt: null, publicByDisc: false,
      outsideAt: null, jailOutAt: null, jailId: null, freezeUntil: 0, photoDueAt: null, publicByPhoto: false,
      trail: [], rescueStart: null, outReason: ''
    };
  }

  // ---------------- 접속 관리 ----------------
  onClose(ws) {
    const pid = this.sockets.get(ws);
    if (!pid) return;
    this.sockets.delete(ws);
    const p = this.g && this.g.players.find(x => x.id === pid);
    if (p && ![...this.sockets.values()].includes(pid)) {
      const wasAway = p.away;
      p.connected = false; p.discAt = Date.now(); p.rescueStart = null;
      if (this.g.phase === 'playing') this.toastAll(p.name + '님 연결이 끊겼어요', p.id);
      if (!wasAway && !p.left) this.screenOff(p);
    }
    if (this.sockets.size === 0) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.ctx.storage.setAlarm(Date.now() + 2 * 3600 * 1000);
    }
    this.changed();
  }
  async alarm() {
    if (this.sockets.size === 0) { await this.ctx.storage.deleteAll(); this.g = null; this.photos = {}; }
  }
  ensureTimer() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
  }
  async save(force) {
    const now = Date.now();
    if (!this.g) return;
    if (!force && now - this.lastSave < 15000) { this.dirty = true; return; }
    this.lastSave = now; this.dirty = false; this.g.touched = now;
    const copy = { ...this.g, players: this.g.players.map(p => ({ ...p, trail: p.trail.slice(-400) })) };
    await this.ctx.storage.put('g', copy);
  }
  changed(force) { this.broadcast(); this.save(force); }

  toast(p, text) {
    for (const [ws, pid] of this.sockets) if (pid === p.id) { try { ws.send(JSON.stringify({ type: 'toast', text })); } catch (e) {} }
    if (!p.connected && this.g && this.g.phase !== 'lobby') this.notify(p, '글로벌 술래잡기', text);
  }
  // 화면이 꺼져 있는 사람에게 푸시 알림
  async vapidKeys() {
    if (!this.vapid) { const r = await this.env.ROOM.get(this.env.ROOM.idFromName('__vapid__')).fetch('https://room/vapid'); this.vapid = await r.json(); }
    return this.vapid;
  }
  notify(p, title, body, force) {
    if (!p.push) return;
    const now = Date.now();
    if (!force && p.lastPush && now - p.lastPush < 3000) return;
    p.lastPush = now;
    const sub = p.push;
    (async () => {
      const res = await sendPush(sub, { title, body, tag: force ? 'urgent' : 'gt', url: this.origin || '/' }, await this.vapidKeys(), this.origin || 'https://global-tag.workers.dev');
      if (res === 'gone' && p.push === sub) { p.push = null; this.save(); }
    })().catch(() => {});
  }
  screenOff(p) {
    const g = this.g;
    if (g.phase !== 'playing' && g.phase !== 'hiding') return;
    this.notify(p, '화면이 꺼졌어요!', g.settings.disconnectAllow + '초 안에 다시 켜지 않으면 내 위치가 모두에게 공개돼요. 지금 화면을 켜 주세요', true);
  }
  toastAll(text, exceptId) { for (const [ws, pid] of this.sockets) if (pid !== exceptId) { try { ws.send(JSON.stringify({ type: 'toast', text })); } catch (e) {} } }
  toastWhere(fn, text) { this.g.players.forEach(p => { if (fn(p)) this.toast(p, text); }); }

  // ---------------- 메시지 ----------------
  onMessage(ws, raw) {
    const g = this.g; if (!g) return;
    const pid = this.sockets.get(ws);
    const p = g.players.find(x => x.id === pid);
    if (!p) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const S = g.settings, now = Date.now();
    switch (m.type) {
      case 'ping': try { ws.send(JSON.stringify({ type: 'pong', now })); } catch (e) {} return;
      case 'pos': {
        const lat = +m.lat, lng = +m.lng;
        if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
        p.lat = lat; p.lng = lng; p.acc = +m.acc || null; p.lastPosAt = now;
        if (!p.away) p.known = { lat, lng };
        if (g.phase === 'lobby' && p.host && g.area.length < 3) { g.area = hexArea({ lat, lng }, 150); this.changed(); }
        else if (g.phase === 'lobby') this.broadcast();
        return;
      }
      case 'away':
        if (!p.away) { p.away = true; p.connected = false; p.discAt = now; p.rescueStart = null; if (g.phase === 'playing') this.toastAll(p.name + '님 화면이 꺼졌어요', p.id); this.screenOff(p); }
        this.changed(); return;
      case 'back':
        if (p.away) { p.away = false; p.connected = true; p.discAt = null; p.publicByDisc = false; if (g.phase === 'playing') this.toast(p, '복귀했어요 · 그대로 이어서 해요'); }
        this.changed(); return;
      case 'wish': if (g.phase === 'lobby') { p.wish = !!m.on; this.changed(); } return;
      case 'check': p.checked = !!m.ok; this.changed(true); return;
      case 'push': {
        const sub = m.sub;
        if (sub && typeof sub.endpoint === 'string' && sub.endpoint.startsWith('https://') && sub.keys && sub.keys.p256dh && sub.keys.auth) {
          p.push = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
        } else p.push = null;
        this.changed(true); return;
      }
      case 'pushTest': if (p.push) { this.notify(p, '알림 테스트', '이렇게 알림이 와요. 게임 중 화면이 꺼지면 이 알림으로 알려줘요', true); } return;
      case 'settings': if (p.host && g.phase === 'lobby') { this.applySettings(m.settings || {}); this.changed(true); } return;
      case 'area':
        if (p.host && g.phase === 'lobby' && Array.isArray(m.pts) && m.pts.length >= 3 && m.pts.length <= 500) {
          g.area = m.pts.map(q => [+q[0], +q[1]]).filter(q => isFinite(q[0]) && isFinite(q[1]));
          this.changed(true);
        }
        return;
      case 'jails':
        if (p.host && g.phase === 'lobby' && Array.isArray(m.list)) {
          g.jails = m.list.slice(0, 5).map(q => ({ id: 'j' + (++g.seq), lat: +q[0], lng: +q[1] })).filter(j => isFinite(j.lat) && isFinite(j.lng));
          this.changed(true);
        }
        return;
      case 'start': if (p.host && g.phase === 'lobby') this.startGame(p); return;
      case 'report': this.report(p); return;
      case 'cancel':
        g.reports = g.reports.filter(r => r.from !== p.id);
        if (p.state === 'pending') p.state = 'alive';
        this.changed(); return;
      case 'confirm': this.confirm(m.rid, p); return;
      case 'deny': this.deny(m.rid, p); return;
      case 'rescue':
        if (m.on) { if (this.rescueTarget(p)) p.rescueStart = now; } else p.rescueStart = null;
        this.broadcast(); return;
      case 'photo': this.photo(p, m.data); return;
      case 'photoGet': {
        const ph = this.photos[m.id];
        if (ph && (this.canViewPhotos(p) || g.phase === 'ended')) try { ws.send(JSON.stringify({ type: 'photo', id: m.id, data: ph.data })); } catch (e) {}
        return;
      }
      case 'toLobby': if (p.host && g.phase === 'ended') this.toLobby(); return;
      case 'leave': this.leave(p, ws); return;
    }
  }

  applySettings(s) {
    const S = this.g.settings;
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in s)) continue;
      if (NUM_LIMITS[k]) { const v = Math.round(+s[k]); if (isFinite(v)) S[k] = Math.min(NUM_LIMITS[k][1], Math.max(NUM_LIMITS[k][0], v)); }
      else if (ENUMS[k]) { if (ENUMS[k].includes(s[k])) S[k] = s[k]; }
      else if (BOOLS.includes(k)) S[k] = !!s[k];
    }
  }

  leave(p, ws) {
    const g = this.g;
    p.left = true;
    if (g.phase === 'lobby' || g.phase === 'ended') {
      g.players = g.players.filter(x => x !== p);
      if (p.host && g.players.length) { g.players[0].host = true; this.toast(g.players[0], '이제 내가 방장이에요'); }
    } else {
      if (p.state !== 'out') this.setOut(p, '게임을 나감');
      p.connected = false; p.discAt = Date.now();
    }
    g.reports = g.reports.filter(r => r.from !== p.id);
    this.toastAll(p.name + '님이 나갔어요', p.id);
    try { ws.send(JSON.stringify({ type: 'left' })); ws.close(1000, 'left'); } catch (e) {}
    this.sockets.delete(ws);
    this.changed(true);
  }

  // ---------------- 게임 흐름 ----------------
  startGame(host) {
    const g = this.g, S = g.settings;
    if (g.players.length < 2) { this.toast(host, '2명 이상 모여야 시작할 수 있어요'); return; }
    if (g.area.length < 3) { this.toast(host, '먼저 경기장을 그려 주세요'); return; }
    const noPos = g.players.filter(p => p.lat == null);
    if (noPos.length) { this.toast(host, '위치가 꺼진 사람이 있어서 시작할 수 없어요: ' + noPos.map(p => p.name).join(', ')); return; }
    const noCheck = g.players.filter(p => !p.checked);
    if (noCheck.length) { this.toast(host, '소리 점검을 안 한 사람이 있어요: ' + noCheck.map(p => p.name).join(', ')); return; }
    const n = Math.min(Math.max(1, S.chaserCount), g.players.length - 1);
    const wishers = shuffle(g.players.filter(p => p.wish));
    const others = shuffle(g.players.filter(p => !p.wish));
    const pick = wishers.concat(others).slice(0, n);
    const now = Date.now();
    g.players.forEach(p => {
      p.role = pick.includes(p) ? 'chaser' : 'runner';
      p.state = 'alive'; p.outsideAt = null; p.jailOutAt = null; p.jailId = null; p.freezeUntil = 0;
      p.photoDueAt = null; p.publicByPhoto = false; p.publicByDisc = false; p.trail = []; p.rescueStart = null; p.outReason = '';
      if (!p.connected && p.discAt == null) p.discAt = now;
    });
    g.reports = []; g.album = []; this.photos = {}; g.catchCount = 0; g.winner = null; g.winReason = '';
    g.phase = 'hiding'; g.hideEndsAt = now + S.hideTime * 1000; g.endsAt = 0;
    g.players.forEach(p => this.toast(p, p.role === 'chaser'
      ? '나는 ' + TN[S.mode][0] + '! 숨는 시간 동안 기다려요'
      : '나는 ' + TN[S.mode][1] + '! 지금 숨으세요'));
    this.changed(true);
  }
  beginPlay() {
    const g = this.g, S = g.settings, now = Date.now();
    g.phase = 'playing'; g.endsAt = now + S.timeLimit * 1000;
    g.snap = { C2R: { at: now, pos: {} }, R2C: { at: now, pos: {} } };
    g.nextPhotoAt = now + S.photoEvery * 1000;
    g.players.forEach(p => { if (!p.connected) p.discAt = now; this.toast(p, p.role === 'chaser' ? '출발! 잡으러 가요' : '게임 시작! 들키지 마세요'); });
    this.changed(true);
  }
  toLobby() {
    const g = this.g;
    g.phase = 'lobby'; g.reports = []; g.album = []; this.photos = {}; g.winner = null; g.winReason = '';
    g.players.forEach(p => { p.role = 'runner'; p.state = 'alive'; p.trail = []; p.outsideAt = null; p.jailOutAt = null; p.jailId = null; p.publicByPhoto = false; p.photoDueAt = null; p.outReason = ''; });
    this.changed(true);
  }
  setOut(p, reason) {
    p.state = 'out'; p.outReason = reason; p.outsideAt = null; p.jailOutAt = null; p.jailId = null; p.rescueStart = null; p.photoDueAt = null;
    this.g.reports = this.g.reports.filter(r => r.from !== p.id);
    this.toast(p, reason + ' · 탈락했어요');
    this.toastAll(p.name + '님 탈락 (' + reason + ')', p.id);
  }
  nearestChaser(p) {
    let best = null, bd = Infinity;
    this.g.players.forEach(c => {
      if (c.role !== 'chaser' || c.state === 'out') return;
      const d = distM(p, c.connected ? c : (c.known || c));
      if (d < bd) { bd = d; best = c; }
    });
    return best ? { c: best, d: bd } : null;
  }
  canReport(p) {
    if (this.g.phase !== 'playing' || p.role !== 'runner' || p.state !== 'alive') return false;
    const n = this.nearestChaser(p);
    return !!n && n.d <= this.g.settings.catchDist;
  }
  report(p) {
    if (!this.canReport(p)) { this.toast(p, '근처에 ' + TN[this.g.settings.mode][0] + '가 없어서 신고할 수 없어요'); this.broadcast(); return; }
    p.state = 'pending';
    this.g.reports.push({ id: 'r' + (++this.g.seq), from: p.id, at: Date.now() });
    this.toastWhere(c => c.role === 'chaser' && c.state !== 'out', p.name + '님이 잡혔다고 신고했어요');
    this.changed();
  }
  confirm(rid, chaser) {
    const g = this.g, S = g.settings;
    if (chaser.role !== 'chaser' || chaser.state === 'out') return;
    const r = g.reports.find(x => x.id === rid); if (!r) return;
    g.reports = g.reports.filter(x => x !== r);
    const p = g.players.find(x => x.id === r.from); if (!p || p.state !== 'pending') { this.broadcast(); return; }
    g.catchCount++;
    if (S.mode === 'cops') {
      if (g.jails.length) {
        let best = g.jails[0];
        g.jails.forEach(j => { if (distM(p, j) < distM(p, best)) best = j; });
        p.state = 'jailed'; p.jailId = best.id; p.jailOutAt = null;
        const idx = g.jails.indexOf(best) + 1;
        this.toast(p, '체포됐어요! 감옥 ' + idx + '(으)로 가세요. 감옥 밖에 오래 있으면 탈락해요');
        this.toastAll(chaser.name + '님이 ' + p.name + '님을 체포했어요', p.id);
      } else this.setOut(p, '체포');
    } else if (S.mode === 'zombie') {
      p.role = 'chaser'; p.state = 'alive';
      this.toast(p, '좀비가 됐어요! 이제 생존자를 잡아요');
      this.toastAll(p.name + '님이 감염됐어요', p.id);
    } else if (S.transfer) {
      p.role = 'chaser'; p.state = 'alive'; p.freezeUntil = Date.now() + S.transferCountdown * 1000;
      chaser.role = 'runner'; chaser.state = 'alive'; chaser.freezeUntil = 0;
      this.toast(p, '술래가 됐어요! 카운트다운이 끝나면 출발해요');
      this.toast(chaser, '술래를 넘겼어요. 이제 도망쳐요!');
      this.toastAll(p.name + '님이 새 술래예요', p.id);
    } else {
      p.state = 'out'; p.outReason = '잡힘';
      this.toast(p, '아웃됐어요. 관전하면서 모두의 위치를 볼 수 있어요');
      this.toastAll(p.name + '님 아웃!', p.id);
    }
    this.checkWin();
    this.changed(true);
  }
  deny(rid, chaser) {
    const g = this.g;
    if (chaser.role !== 'chaser') return;
    const r = g.reports.find(x => x.id === rid); if (!r) return;
    g.reports = g.reports.filter(x => x !== r);
    const p = g.players.find(x => x.id === r.from);
    if (p && p.state === 'pending') { p.state = 'alive'; this.toast(p, chaser.name + '님이 안 잡혔다고 했어요. 계속 도망쳐요!'); }
    this.changed();
  }
  rescueTarget(p) {
    const g = this.g, S = g.settings;
    if (S.mode !== 'cops' || g.phase !== 'playing' || p.role !== 'runner' || p.state !== 'alive' || !p.connected) return null;
    for (const j of g.jails) {
      if (distM(p, j) <= S.jailRadius) {
        const inmates = g.players.filter(q => q.state === 'jailed' && q.jailId === j.id);
        if (inmates.length) return { jail: j, inmates };
      }
    }
    return null;
  }
  canViewPhotos(v) { const S = this.g.settings; return S.photoViewers === 'all' || v.role === 'chaser' || v.state === 'out'; }
  isPhotoSender(p) { const S = this.g.settings; return p.state !== 'out' && p.state !== 'jailed' && (S.photoSenders === 'all' || p.role === 'runner'); }
  photo(p, data) {
    const g = this.g;
    if (g.phase !== 'playing' || typeof data !== 'string' || !data.startsWith('data:image/') || data.length > 700000) return;
    if (p.photoDueAt == null && !p.publicByPhoto) return;
    const id = 'ph' + (++g.seq);
    this.photos[id] = { data };
    const left = g.endsAt - Date.now();
    g.album.push({ id, from: p.name, at: Math.max(0, Math.round(left / 1000)) });
    p.photoDueAt = null; p.publicByPhoto = false;
    this.toast(p, '사진을 보냈어요');
    this.toastWhere(v => v !== p && this.canViewPhotos(v), p.name + '님이 사진을 보냈어요');
    this.changed();
  }
  endGame(win, reason) {
    const g = this.g;
    if (g.phase !== 'playing') return;
    g.phase = 'ended'; g.winner = win; g.winReason = reason;
    g.players.forEach(p => { p.rescueStart = null; p.photoDueAt = null; });
    const tn = TN[g.settings.mode];
    g.players.forEach(p => this.toast(p, '게임 끝! ' + (win === 'chaser' ? tn[0] : tn[1]) + ' 팀 승리 · ' + reason));
    this.changed(true);
  }
  checkWin() {
    const g = this.g, S = g.settings;
    if (g.phase !== 'playing') return;
    const runners = g.players.filter(p => p.role === 'runner');
    const chasers = g.players.filter(p => p.role === 'chaser' && p.state !== 'out');
    const N = S.winMode === 'n' ? Math.max(1, S.winN) : 0;
    const cw = TN[S.mode][0], rw = TN[S.mode][1];
    if (!chasers.length) return this.endGame('runner', cw + ' 팀이 모두 탈락했어요');
    if (S.mode === 'cops') {
      const thieves = runners.filter(p => p.state !== 'out');
      const jailed = thieves.filter(p => p.state === 'jailed').length;
      const free = thieves.filter(p => p.state === 'alive' || p.state === 'pending').length;
      if (!thieves.length) return this.endGame('chaser', '도둑이 모두 탈락했어요');
      if (N ? jailed >= N : free === 0) return this.endGame('chaser', N ? '도둑 ' + N + '명을 동시에 가뒀어요' : '도둑을 모두 가뒀어요');
    } else if (S.mode === 'zombie') {
      const surv = runners.filter(p => p.state !== 'out');
      if (!surv.length) return this.endGame('chaser', '생존자가 모두 감염됐어요');
      if (N && g.catchCount >= N) return this.endGame('chaser', N + '명을 감염시켰어요');
    } else if (S.transfer) {
      if (N && g.catchCount >= N) return this.endGame('chaser', N + '번 잡았어요');
    } else {
      const alive = runners.filter(p => p.state === 'alive' || p.state === 'pending');
      if (!alive.length) return this.endGame('chaser', rw + '를 모두 잡았어요');
      if (N && g.catchCount >= N) return this.endGame('chaser', N + '명을 잡았어요');
    }
    if (Date.now() >= g.endsAt) this.endGame('runner', '제한 시간까지 버텼어요');
  }

  // ---------------- 매초 처리 ----------------
  tick() {
    const g = this.g; if (!g) return;
    const now = Date.now(), S = g.settings;
    if (g.phase === 'hiding' && now >= g.hideEndsAt) this.beginPlay();
    if (g.phase === 'playing') {
      g.players.forEach(p => {
        if (p.state !== 'out' && p.lat != null && (!p.trailAt || now - p.trailAt >= 5000)) { p.trailAt = now; p.trail.push([+p.lat.toFixed(6), +p.lng.toFixed(6), p.role === 'chaser' ? 1 : 0]); }
        if (p.state === 'out' || p.lat == null) return;
        if (p.connected) {
          if (!inPoly(p, g.area)) {
            if (p.outsideAt == null) { p.outsideAt = now; }
            else if (now - p.outsideAt >= S.boundaryAllow * 1000) { this.setOut(p, '경기장 이탈'); return; }
          } else if (p.outsideAt != null) { p.outsideAt = null; this.toast(p, '경기장으로 돌아왔어요'); }
          if (p.state === 'jailed') {
            const j = g.jails.find(x => x.id === p.jailId);
            if (!j) { p.state = 'alive'; p.jailId = null; }
            else if (distM(p, j) > S.jailRadius) {
              if (p.jailOutAt == null) p.jailOutAt = now;
              else if (now - p.jailOutAt >= S.boundaryAllow * 1000) { this.setOut(p, '감옥 이탈'); return; }
            } else if (p.jailOutAt != null) { p.jailOutAt = null; this.toast(p, '감옥 안으로 돌아왔어요'); }
          } else p.jailOutAt = null;
        }
        if (!p.connected && !p.publicByDisc && p.discAt != null && now - p.discAt >= S.disconnectAllow * 1000) {
          p.publicByDisc = true;
          this.notify(p, '내 위치가 공개됐어요', '화면이 너무 오래 꺼져 있었어요. 다시 켜면 숨겨져요', true);
          this.toastAll(p.name + '님 연결이 ' + S.disconnectAllow + '초 넘게 끊겨서 마지막 위치가 공개됐어요', p.id);
        }
        if (p.photoDueAt != null && now >= p.photoDueAt) {
          p.photoDueAt = null; p.publicByPhoto = true;
          this.toast(p, '사진을 안 보내서 내 위치가 공개됐어요');
        }
      });
      for (const k of ['C2R', 'R2C']) {
        if (S['reveal' + k] !== 'interval') continue;
        const snap = g.snap[k];
        if (now - snap.at >= S['reveal' + k + 'Sec'] * 1000) {
          snap.at = now; snap.pos = {};
          const targetRole = k === 'C2R' ? 'runner' : 'chaser';
          g.players.forEach(p => { if (p.role === targetRole && p.state !== 'out' && p.known) snap.pos[p.id] = { lat: p.known.lat, lng: p.known.lng }; });
        }
      }
      if (S.photoOn && now >= g.nextPhotoAt) {
        g.nextPhotoAt = now + S.photoEvery * 1000;
        g.players.forEach(p => { if (this.isPhotoSender(p)) { p.photoDueAt = now + S.photoDeadline * 1000; this.toast(p, '사진 보낼 시간이에요!'); } });
      }
      g.players.forEach(p => {
        if (p.rescueStart == null) return;
        const rt = this.rescueTarget(p);
        if (!rt) { p.rescueStart = null; return; }
        if (now - p.rescueStart >= S.rescueHold * 1000) {
          rt.inmates.forEach(q => { q.state = 'alive'; q.jailId = null; q.jailOutAt = null; this.toast(q, p.name + '님이 구출했어요! 도망쳐요'); });
          this.toast(p, '도둑 ' + rt.inmates.length + '명을 구출했어요!');
          this.toastWhere(c => c.role === 'chaser', '감옥이 털렸어요! ' + rt.inmates.length + '명 탈출');
          p.rescueStart = null;
        }
      });
      this.checkWin();
    }
    if (g.phase === 'hiding' || g.phase === 'playing') this.broadcast();
    if (this.dirty) this.save();
  }

  // ---------------- 사람마다 다른 화면 정보 ----------------
  view(v) {
    const g = this.g, S = g.settings, now = Date.now();
    const playing = g.phase === 'playing', inGame = playing || g.phase === 'hiding';
    const tokens = [];
    g.players.forEach(p => {
      const pos = p.connected ? (p.lat != null ? { lat: p.lat, lng: p.lng } : null) : p.known;
      if (p === v) { if (p.lat != null) tokens.push({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, kind: 'me', acc: p.acc }); return; }
      if (!inGame && g.phase !== 'lobby') return;
      if (!pos) return;
      const base = { id: p.id, name: p.name, lat: pos.lat, lng: pos.lng, disc: !p.connected, jailed: p.state === 'jailed' };
      if (g.phase === 'lobby') { if (v.host) tokens.push({ ...base, kind: 'team' }); return; }
      if (p.state === 'out') { tokens.push({ ...base, kind: 'out' }); return; }
      if (v.state === 'out') { tokens.push({ ...base, kind: p.role === 'chaser' ? 'enemy' : 'team' }); return; }
      if (p.role === v.role) { if (S.teamSee) tokens.push({ ...base, kind: 'team' }); return; }
      if (p.publicByPhoto || p.publicByDisc) { tokens.push({ ...base, kind: 'enemy', pub: true }); return; }
      if (!playing) return;
      const k = v.role === 'chaser' ? 'C2R' : 'R2C', mode = S['reveal' + k];
      if (mode === 'always') tokens.push({ ...base, kind: 'enemy' });
      else if (mode === 'interval') { const sp = g.snap[k].pos[p.id]; if (sp) tokens.push({ ...base, lat: sp.lat, lng: sp.lng, kind: 'enemy', stale: Math.round((now - g.snap[k].at) / 1000) }); }
    });
    const near = v.role === 'runner' && v.state === 'alive' && playing ? this.nearestChaser(v) : null;
    const rt = this.rescueTarget(v);
    const me = {
      id: v.id, name: v.name, host: v.host, role: v.role, state: v.state, wish: v.wish, checked: !!v.checked, push: !!v.push, outReason: v.outReason,
      hasPos: v.lat != null, acc: v.acc,
      outsideLeft: v.outsideAt != null ? Math.max(0, S.boundaryAllow - (now - v.outsideAt) / 1000) : null,
      jailOutLeft: v.jailOutAt != null ? Math.max(0, S.boundaryAllow - (now - v.jailOutAt) / 1000) : null,
      photoLeft: v.photoDueAt != null ? Math.max(0, (v.photoDueAt - now) / 1000) : null,
      publicByPhoto: v.publicByPhoto, publicByDisc: v.publicByDisc,
      freezeLeft: v.freezeUntil > now ? (v.freezeUntil - now) / 1000 : 0,
      canReport: this.canReport(v), nearDist: near ? Math.round(near.d) : null,
      rescue: rt ? { inmates: rt.inmates.length, progress: v.rescueStart ? Math.min(1, (now - v.rescueStart) / (S.rescueHold * 1000)) : 0 } : null,
      jailIndex: v.jailId ? g.jails.findIndex(j => j.id === v.jailId) + 1 : 0
    };
    const runners = g.players.filter(p => p.role === 'runner');
    const alive = S.mode === 'cops' ? runners.filter(p => p.state === 'alive' || p.state === 'pending').length : runners.filter(p => p.state !== 'out').length;
    const out = {
      type: 'state', now, code: g.code, phase: g.phase, settings: S,
      hideEndsAt: g.hideEndsAt, endsAt: g.endsAt, area: g.area, jails: g.jails.map(j => [j.lat, j.lng]),
      players: g.players.map(p => ({ id: p.id, name: p.name, host: p.host, wish: p.wish, role: g.phase === 'lobby' ? null : p.role, state: p.state, connected: p.connected, hasPos: p.lat != null, checked: !!p.checked, push: !!p.push })),
      me, tokens, alive, catchCount: g.catchCount,
      reports: v.role === 'chaser' && v.state !== 'out' && playing ? g.reports.map(r => { const p = g.players.find(x => x.id === r.from); return p ? { id: r.id, name: p.name, dist: Math.round(distM(v, p.connected ? p : (p.known || p))) } : null; }).filter(Boolean) : [],
      album: this.canViewPhotos(v) || g.phase === 'ended' ? g.album : [],
      canViewPhotos: this.canViewPhotos(v),
      winner: g.winner, winReason: g.winReason
    };
    if (g.phase === 'ended') out.trails = g.players.map(p => ({ name: p.name, role: p.role, state: p.state, pts: p.trail.map(t => [t[0], t[1]]) }));
    return out;
  }
  broadcast() {
    if (!this.g) return;
    for (const [ws, pid] of this.sockets) {
      const p = this.g.players.find(x => x.id === pid);
      if (!p) continue;
      try { ws.send(JSON.stringify(this.view(p))); } catch (e) {}
    }
  }
}
