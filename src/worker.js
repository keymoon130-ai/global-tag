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
  catchDist: 30, boundaryAllow: 60, disconnectAllow: 60, autoOut: 180, transfer: false, transferCountdown: 10,
  rescueHold: 3, jailRadius: 20,
  copsMajority: false,
  radarRangeOn: false, radarRangeDist: 50, radarSightOn: false, radarSightDist: 60, radarSightAngle: 60, radarCooldown: 0, radarActive: 15,
  photoOn: false, photoEvery: 600, photoDeadline: 90, photoSenders: 'runners', photoViewers: 'chasers'
};
const NUM_LIMITS = {
  chaserCount: [1, 10], timeLimit: [60, 7200], hideTime: [0, 1800], winN: [1, 20], revealC2RSec: [3, 600], revealR2CSec: [3, 600],
  catchDist: [3, 200], boundaryAllow: [5, 600], disconnectAllow: [10, 600], autoOut: [60, 1800], transferCountdown: [0, 120], rescueHold: [1, 30],
  jailRadius: [5, 100], radarRangeDist: [10, 300], radarSightDist: [10, 300], radarSightAngle: [20, 180], radarCooldown: [0, 600], radarActive: [5, 120], photoEvery: [60, 3600], photoDeadline: [15, 600]
};
const ENUMS = {
  mode: ['tag', 'hide', 'cops', 'zombie'], winMode: ['all', 'n'], revealC2R: ['hidden', 'interval', 'always'],
  revealR2C: ['hidden', 'interval', 'always'], photoSenders: ['runners', 'all'], photoViewers: ['chasers', 'all']
};
const BOOLS = ['teamSee', 'transfer', 'photoOn', 'copsMajority', 'radarRangeOn', 'radarSightOn'];
const TN = { tag: ['술래', '도망자'], hide: ['술래', '숨는 사람'], cops: ['경찰', '도둑'], zombie: ['좀비', '생존자'] };
// 설정 변경 알림용 이름 ({C}/{R}는 모드에 맞는 이름으로 바뀌어요)
const LABELS = {
  mode: '모드', chaserCount: '{C} 인원', timeLimit: '게임 시간', hideTime: '숨는 시간', winMode: '이기는 조건', winN: '잡아야 하는 수',
  revealC2R: '{C}에게 {R} 위치', revealC2RSec: '{C} 위치 보기 간격', revealR2C: '{R}에게 {C} 위치', revealR2CSec: '{R} 위치 보기 간격', teamSee: '같은 편 위치 보기',
  catchDist: '잡는 거리', boundaryAllow: '경기장 밖 허용 시간', disconnectAllow: '화면 꺼짐 허용 시간', autoOut: '연결 끊김 탈락 시간', transfer: '술래 넘기기', transferCountdown: '새 술래 대기 시간',
  rescueHold: '구출 버튼 누르는 시간', jailRadius: '감옥 크기', copsMajority: '절반 넘게 갇히면 경찰 승리', radarRangeOn: '범위 레이더', radarRangeDist: '범위 레이더 거리', radarSightOn: '시야 레이더', radarSightDist: '시야 레이더 거리', radarSightAngle: '시야각', radarCooldown: '레이더 쉬는 시간', radarActive: '레이더 작동 시간', photoOn: '사진 모드', photoEvery: '사진 간격', photoDeadline: '사진 제한 시간', photoSenders: '사진 보내는 사람', photoViewers: '사진 보는 사람'
};
const VALUE_NAMES = { tag: '술래잡기', hide: '숨바꼭질', cops: '경찰과 도둑', zombie: '좀비감염', all: '전원', n: '정한 수만큼', hidden: '안 보임', interval: '가끔', always: '항상', runners: '{R}만', chasers: '{C}만', true: '켬', false: '끔' };
const TIME_KEYS = ['timeLimit', 'hideTime', 'revealC2RSec', 'revealR2CSec', 'boundaryAllow', 'disconnectAllow', 'autoOut', 'transferCountdown', 'rescueHold', 'radarCooldown', 'radarActive', 'photoEvery', 'photoDeadline'];
const UNITS = { chaserCount: '명', winN: '명', catchDist: 'm', jailRadius: 'm', radarRangeDist: 'm', radarSightDist: 'm', radarSightAngle: '°' };
function dur(sec) { sec = Math.round(sec); const m = Math.floor(sec / 60), s = sec % 60; return m && s ? m + '분 ' + s + '초' : m ? m + '분' : s + '초'; }
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const IDLE_MS = 15 * 60 * 1000;

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
// 경계선까지 거리(m): 근처 좁은 범위라 평면으로 계산해요
function distToPolyM(pt, poly) {
  if (!poly || poly.length < 2 || pt.lat == null) return Infinity;
  const k = 111320, kx = 111320 * Math.cos(pt.lat * Math.PI / 180);
  const P = poly.map(q => [(q[1] - pt.lng) * kx, (q[0] - pt.lat) * k]);
  let best = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const ax = P[j][0], ay = P[j][1], bx = P[i][0], by = P[i][1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const EDGE_MARGIN = 10, CONFIRM_MS = 5000, BAD_ACC = 50;
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
    this.lastActive = Date.now();
    ctx.blockConcurrencyWhile(async () => {
      this.g = (await ctx.storage.get('g')) || null;
      // 서버가 다시 시작되면 아무도 연결돼 있지 않아요 (재접속하면 다시 연결됨)
      if (this.g) { const now = Date.now(); this.g.vote = null; this.g.players.forEach(p => { if (p.connected) { p.connected = false; p.away = false; p.discAt = now; } }); }
    });
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
    if (!p) {
      // 같은 닉네임은 못 써요. 끊긴 사람이고 본인이 맞다고 확인하면 이어받아요 (아이폰 홈 화면 앱 등)
      const same = g.players.find(x => x.name === name);
      if (same) {
        if (url.searchParams.get('takeover') === '1' && !same.connected) { same.token = token; p = same; }
        else {
          send({ type: 'error', code: 'dupname', name, canTakeover: !same.connected, text: same.connected ? '이 방에 "' + name + '" 닉네임이 이미 있어요. 다른 닉네임으로 들어와 주세요.' : '"' + name + '" 닉네임이 이미 있어요. 본인이 맞으면 이어받을 수 있어요.' });
          server.close(4003, 'dupname');
          return new Response(null, { status: 101, webSocket: client });
        }
      }
    }
    if (!p) {
      if (g.players.length >= MAX_PLAYERS) { send({ type: 'error', code: 'full', text: '방이 가득 찼어요 (최대 ' + MAX_PLAYERS + '명).' }); server.close(4001, 'full'); return new Response(null, { status: 101, webSocket: client }); }
      p = this.newPlayer(token, name);
      if (g.phase !== 'lobby') { p.state = 'out'; p.late = true; p.outReason = '게임 중간에 들어와서 다음 판부터 참가해요'; }
      g.players.push(p);
      this.toastAll(p.name + '님이 들어왔어요', p.id);
    } else {
      p.name = name;
      if (!p.connected && g.phase === 'playing') { this.toast(p, '복귀했어요 · 그대로 이어서 해요'); this.toastAll(p.name + '님이 다시 연결됐어요', p.id); }
    }
    if (!g.players.some(x => x.host)) p.host = true;
    for (const [ws, pid] of this.sockets) if (pid === p.id) { try { ws.close(4002, 'replaced'); } catch (e) {} this.sockets.delete(ws); }
    this.sockets.set(server, p.id);
    this.lastActive = Date.now();
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
    this.notify(p, '화면이 꺼졌어요!', dur(g.settings.disconnectAllow) + ' 안에 다시 켜지 않으면 내 위치가 모두에게 공개돼요. 지금 화면을 켜 주세요', true);
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
    if (m.type !== 'ping' && m.type !== 'pos') this.lastActive = now;
    switch (m.type) {
      case 'ping': try { ws.send(JSON.stringify({ type: 'pong', now })); } catch (e) {} return;
      case 'pos': {
        const lat = +m.lat, lng = +m.lng;
        if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
        p.lat = lat; p.lng = lng; p.acc = +m.acc || null; p.lastPosAt = now;
        if (!p.away) p.known = { lat, lng };
        if (g.phase === 'lobby') this.broadcast();
        return;
      }
      case 'photoMode': p.photoGraceUntil = now + 120000; return;
      case 'away':
        // 사진 찍으러 카메라로 간 경우 2분은 봐줘요
        if (p.photoGraceUntil && now < p.photoGraceUntil && !p.away) { p.photoAway = true; return; }
        if (!p.away) { p.away = true; p.connected = false; p.discAt = now; p.rescueStart = null; if (g.phase === 'playing') this.toastAll(p.name + '님 화면이 꺼졌어요', p.id); this.screenOff(p); }
        this.changed(); return;
      case 'back':
        p.photoAway = false;
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
      case 'settings':
        if (p.host && g.phase === 'lobby') {
          const before = { ...S };
          this.applySettings(m.settings || {});
          const diff = Object.keys(DEFAULTS).filter(k => before[k] !== S[k]).map(k => {
            const w = TN[S.mode] || TN.tag, nm = t => String(t).replace(/\{C\}/g, w[0]).replace(/\{R\}/g, w[1]);
            const f = v => TIME_KEYS.includes(k) ? dur(v) : nm(VALUE_NAMES[String(v)] || v) + (UNITS[k] || '');
            return nm(LABELS[k]) + ' ' + f(before[k]) + ' → ' + f(S[k]);
          });
          if (diff.length) this.toastAll('방장이 설정을 바꿨어요: ' + diff.slice(0, 4).join(', ') + (diff.length > 4 ? ' 외 ' + (diff.length - 4) + '개' : ''), p.id);
          this.changed(true);
        }
        return;
      case 'area':
        if (p.host && g.phase === 'lobby' && Array.isArray(m.pts) && m.pts.length >= 3 && m.pts.length <= 500) {
          const pts = m.pts.map(q => [+q[0], +q[1]]).filter(q => isFinite(q[0]) && isFinite(q[1]));
          if (pts.length >= 3) { g.area = pts; this.toastAll('방장이 경기장을 바꿨어요. 대기실 지도에서 확인하세요', p.id); this.changed(true); }
        }
        return;
      case 'jails':
        if (p.host && g.phase === 'lobby' && Array.isArray(m.list)) {
          const all = m.list.slice(0, 5).map(q => ({ id: 'j' + (++g.seq), lat: +q[0], lng: +q[1] })).filter(j => isFinite(j.lat) && isFinite(j.lng));
          g.jails = all.filter(j => inPoly(j, g.area));
          if (g.jails.length < all.length) this.toast(p, '경기장 밖에 있는 감옥은 빼고 저장했어요');
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
        if (!(this.canViewPhotos(p) || g.phase === 'ended') || !g.album.some(a => a.id === m.id)) return;
        (async () => {
          let data = this.photos[m.id] && this.photos[m.id].data;
          if (!data) { data = await this.ctx.storage.get('ph:' + m.id); if (data) this.photos[m.id] = { data }; }
          if (data) try { ws.send(JSON.stringify({ type: 'photo', id: m.id, data })); } catch (e) {}
        })();
        return;
      }
      case 'jailNow': {
        const t = this.escortOf(p); if (!t) return;
        const nj = this.nearestJail(p);
        if (nj && nj.d <= S.jailRadius + 25) { this.jailNow(p, t, nj.jail); this.changed(true); }
        else this.toast(p, '감옥 가까이 가야 수감할 수 있어요');
        return;
      }
      case 'toLobby': if (g.phase === 'ended') this.toLobby(); return;
      case 'kickVote': {
        if (!p.host || (g.phase !== 'playing' && g.phase !== 'hiding') || g.vote) return;
        const t = g.players.find(x => x.id === m.target);
        if (!t || t === p || t.state === 'out') return;
        const voters = g.players.filter(x => x !== p && x !== t && x.connected && !x.late).map(x => x.id);
        if (!voters.length) {
          if (!t.connected) { this.setOut(t, '투표로 탈락'); this.checkWin(); }
          else this.toast(p, '투표할 사람이 없어서 탈락시킬 수 없어요');
          this.changed(true); return;
        }
        g.vote = { id: 'v' + (++g.seq), target: t.id, by: p.id, endsAt: now + 30000, voters, yes: [], no: [] };
        this.toastWhere(x => voters.includes(x.id), p.name + '님이 ' + t.name + '님 탈락 투표를 열었어요');
        this.toast(t, '방장이 나를 탈락시키는 투표를 열었어요. "저 여기 있어요"를 누르면 취소돼요');
        this.changed(); return;
      }
      case 'vote': {
        const v = g.vote; if (!v || !v.voters.includes(p.id)) return;
        v.yes = v.yes.filter(x => x !== p.id); v.no = v.no.filter(x => x !== p.id);
        (m.yes ? v.yes : v.no).push(p.id);
        this.resolveVote(false); this.changed(); return;
      }
      case 'imHere': {
        const v = g.vote;
        if (v && v.target === p.id) { g.vote = null; this.toastAll(p.name + '님이 "여기 있어요"를 눌러서 탈락 투표가 취소됐어요', p.id); this.changed(); }
        return;
      }
      case 'leave': this.leave(p, ws); return;
    }
  }

  resolveVote(timeout) {
    const g = this.g, v = g.vote; if (!v) return;
    const need = Math.floor(v.voters.length / 2) + 1;
    const t = g.players.find(x => x.id === v.target);
    if (v.yes.length >= need) {
      g.vote = null;
      if (t && t.state !== 'out') { this.setOut(t, '투표로 탈락'); this.checkWin(); }
    } else if (timeout || v.no.length > v.voters.length - need) {
      g.vote = null;
      this.toastAll((t ? t.name + '님 ' : '') + '탈락 투표가 부결됐어요');
    }
  }
  clearPhotos() {
    const g = this.g;
    const keys = (g.album || []).map(a => 'ph:' + a.id);
    if (keys.length) this.ctx.storage.delete(keys).catch(() => {});
    g.album = []; this.photos = {};
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
    if (S.mode === 'cops') {
      if (!g.jails.length) { this.toast(host, '경찰과 도둑은 감옥이 1개 이상 있어야 해요. 경기장 편집에서 감옥을 놓아 주세요'); return; }
      if (g.jails.some(j => !inPoly(j, g.area))) { this.toast(host, '경기장 밖에 있는 감옥이 있어요. 경기장 편집에서 옮겨 주세요'); return; }
    }
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
      p.photoDueAt = null; p.publicByPhoto = false; p.publicByDisc = false; p.trail = []; p.rescueStart = null; p.outReason = ''; p.escortBy = null; p.escorting = null;
      p.outCand = null; p.jailCand = null; p.protectUntil = 0; p.late = false; p.jailGraceUntil = 0;
      if (!p.connected && p.discAt == null) p.discAt = now;
    });
    this.clearPhotos(); g.vote = null;
    g.reports = []; g.catchCount = 0; g.winner = null; g.winReason = ''; g.lastChaser = null;
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
    // 나간 사람·끊긴 사람은 목록에서 빼요 (다시 들어오면 새로 합류)
    const gone = g.players.filter(p => p.left || !p.connected);
    g.players = g.players.filter(p => !gone.includes(p));
    if (gone.length) this.toastAll('나갔거나 연결이 끊긴 ' + gone.map(p => p.name).join(', ') + '님은 목록에서 뺐어요');
    if (!g.players.some(p => p.host) && g.players.length) g.players[0].host = true;
    this.clearPhotos(); g.vote = null;
    g.phase = 'lobby'; g.reports = []; g.winner = null; g.winReason = '';
    g.players.forEach(p => { p.role = 'runner'; p.state = 'alive'; p.trail = []; p.outsideAt = null; p.jailOutAt = null; p.jailId = null; p.publicByPhoto = false; p.photoDueAt = null; p.outReason = ''; p.escortBy = null; p.escorting = null; p.late = false; p.outCand = null; p.jailCand = null; p.protectUntil = 0; });
    this.changed(true);
  }
  setOut(p, reason) {
    const g = this.g;
    if (p.escortBy) { const c = g.players.find(x => x.id === p.escortBy); if (c) c.escorting = null; p.escortBy = null; }
    if (p.escorting) {
      const t = g.players.find(x => x.id === p.escorting);
      if (t && t.state === 'escort') { t.state = 'alive'; t.escortBy = null; this.toast(t, '연행하던 경찰이 탈락해서 풀려났어요! 도망쳐요'); }
      p.escorting = null;
    }
    if (g.vote && g.vote.target === p.id) g.vote = null;
    p.state = 'out'; p.outReason = reason; p.outsideAt = null; p.jailOutAt = null; p.jailId = null; p.rescueStart = null; p.photoDueAt = null;
    this.g.reports = this.g.reports.filter(r => r.from !== p.id);
    this.toast(p, reason + ' · 탈락했어요');
    this.toastAll(p.name + '님 탈락 (' + reason + ')', p.id);
  }
  nearestChaser(p) {
    let best = null, bd = Infinity;
    this.g.players.forEach(c => {
      if (c.role !== 'chaser' || c.state === 'out' || c.freezeUntil > Date.now()) return;
      const d = distM(p, c.connected ? c : (c.known || c));
      if (d < bd) { bd = d; best = c; }
    });
    return best ? { c: best, d: bd } : null;
  }
  canReport(p) {
    if (this.g.phase !== 'playing' || p.role !== 'runner' || p.state !== 'alive') return false;
    if (p.protectUntil > Date.now()) return false;
    const n = this.nearestChaser(p);
    if (!n) return false;
    // GPS 오차만큼 조금 더 봐줘요 (최대 20m)
    const extra = Math.min(20, Math.min(BAD_ACC, p.acc || 0) + Math.min(BAD_ACC, n.c.acc || 0));
    return n.d <= this.g.settings.catchDist + extra;
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
    if (chaser.freezeUntil > Date.now()) { this.toast(chaser, '카운트다운이 끝난 뒤에 확인할 수 있어요'); return; }
    if (this.escortOf(chaser)) { this.toast(chaser, '연행 중이라 지금은 확인할 수 없어요. 감옥에 넣은 뒤 확인해요'); return; }
    const r = g.reports.find(x => x.id === rid); if (!r) return;
    g.reports = g.reports.filter(x => x !== r);
    const p = g.players.find(x => x.id === r.from); if (!p || p.state !== 'pending') { this.broadcast(); return; }
    g.catchCount++;
    if (S.mode === 'cops') {
      if (g.jails.length) {
        // 강제 연행: 경찰이 감옥까지 데려가야 수감돼요 (탈출 불가)
        p.state = 'escort'; p.escortBy = chaser.id; p.jailOutAt = null; p.outsideAt = null;
        chaser.escorting = p.id;
        this.toast(p, '체포됐어요! ' + chaser.name + '님을 따라 감옥까지 가요 (탈출 불가)');
        this.toast(chaser, p.name + '님 체포! 감옥까지 데려가세요');
        this.toastAll(chaser.name + '님이 ' + p.name + '님을 연행 중이에요', p.id);
      } else this.setOut(p, '체포');
    } else if (S.mode === 'zombie') {
      p.role = 'chaser'; p.state = 'alive'; p.freezeUntil = Date.now() + 10000; // 10초 동안 좀비로 변하는 중 (못 잡음)
      this.toast(p, '감염됐어요! 10초 뒤 좀비로 변해서 생존자를 잡을 수 있어요');
      this.toastAll(p.name + '님이 감염됐어요', p.id);
    } else if (S.transfer) {
      p.role = 'chaser'; p.state = 'alive'; p.freezeUntil = Date.now() + S.transferCountdown * 1000;
      chaser.role = 'runner'; chaser.state = 'alive'; chaser.freezeUntil = 0;
      chaser.protectUntil = Date.now() + S.transferCountdown * 1000; // 바로 다시 잡히지 않게 보호
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
  escortOf(c) {
    if (!c.escorting) return null;
    const t = this.g.players.find(x => x.id === c.escorting);
    if (!t || t.state !== 'escort' || t.escortBy !== c.id) { c.escorting = null; return null; }
    return t;
  }
  nearestJail(pos) {
    let best = null, bd = Infinity;
    this.g.jails.forEach(j => { const d = distM(pos, j); if (d < bd) { bd = d; best = j; } });
    return best ? { jail: best, d: bd } : null;
  }
  jailNow(c, t, j) {
    t.state = 'jailed'; t.jailId = j.id; t.escortBy = null; t.jailOutAt = null; t.outsideAt = null;
    t.jailGraceUntil = Date.now() + 120000; // 경찰보다 늦게 도착해도 2분은 걸어올 시간을 줘요
    c.escorting = null;
    const idx = this.g.jails.indexOf(j) + 1;
    this.toast(t, '감옥 ' + idx + '에 갇혔어요. 동료가 구출하러 올 때까지 원 안에 있어요');
    this.toast(c, t.name + '님 수감 완료! 이제 다른 도둑을 잡으러 가요');
    this.toastAll(t.name + '님이 감옥 ' + idx + '에 갇혔어요', t.id);
    this.checkWin();
  }
  rescueTarget(p) {
    const g = this.g, S = g.settings;
    if (S.mode !== 'cops' || g.phase !== 'playing' || p.role !== 'runner' || p.state !== 'alive' || !p.connected) return null;
    for (const j of g.jails) {
      if (distM(p, j) <= S.jailRadius + EDGE_MARGIN) {
        const inmates = g.players.filter(q => q.state === 'jailed' && q.jailId === j.id);
        if (inmates.length) return { jail: j, inmates };
      }
    }
    return null;
  }
  canViewPhotos(v) { const S = this.g.settings; return S.photoViewers === 'all' || v.role === 'chaser' || v.state === 'out'; }
  isPhotoSender(p) { const S = this.g.settings; return p.state !== 'out' && p.state !== 'jailed' && p.state !== 'escort' && (S.photoSenders === 'all' || p.role === 'runner'); }
  photo(p, data) {
    const g = this.g;
    if (g.phase !== 'playing' || typeof data !== 'string' || data.length > 700000 || !PHOTO_RE.test(data)) return;
    if (p.photoDueAt == null && !p.publicByPhoto) return;
    const id = 'ph' + (++g.seq);
    this.photos[id] = { data };
    this.ctx.storage.put('ph:' + id, data).catch(() => {});
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
    g.players.forEach(p => this.toast(p, g.lastChaser ? '게임 끝! ' + reason : '게임 끝! ' + (win === 'chaser' ? tn[0] : tn[1]) + ' 팀 승리 · ' + reason));
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
      const jailed = thieves.filter(p => p.state === 'jailed' || p.state === 'escort').length;
      const free = thieves.filter(p => p.state === 'alive' || p.state === 'pending').length;
      if (!thieves.length) return this.endGame('chaser', '도둑이 모두 탈락했어요');
      if (N ? jailed >= N : free === 0) return this.endGame('chaser', N ? '도둑 ' + N + '명을 동시에 잡아뒀어요' : '도둑을 모두 잡았어요');
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
    if (Date.now() >= g.endsAt) {
      if (S.mode === 'cops' && S.copsMajority) {
        const thieves = runners.filter(p => p.state !== 'out');
        const caught = thieves.filter(p => p.state === 'jailed' || p.state === 'escort').length;
        if (thieves.length && caught * 2 > thieves.length) return this.endGame('chaser', '시간 종료 · 도둑 과반(' + caught + '/' + thieves.length + '명)이 잡혀 있어요');
      }
      if (S.transfer && (S.mode === 'tag' || S.mode === 'hide')) {
        const last = g.players.filter(p => p.role === 'chaser').map(p => p.name).join(', ');
        g.lastChaser = last;
        return this.endGame('runner', '시간 종료 · 마지막 술래 ' + last + '님 패배');
      }
      this.endGame('runner', '제한 시간까지 버텼어요');
    }
  }

  // ---------------- 매초 처리 ----------------
  tick() {
    const g = this.g; if (!g) return;
    const now = Date.now(), S = g.settings;
    // 방장이 나갔거나 1분 넘게 끊기면 다음 사람이 이어받아요
    const host = g.players.find(p => p.host);
    if (!host || host.left || (!host.connected && host.discAt && now - host.discAt > 60000)) {
      const next = g.players.find(p => p !== host && p.connected && !p.left);
      if (next) { if (host) host.host = false; next.host = true; this.toastAll(next.name + '님이 새 방장이에요'); this.changed(true); }
    }
    // 대기실·결과 화면에서 15분 동안 아무 활동이 없으면 연결을 쉬어요 (무료 사용량 보호)
    if ((g.phase === 'lobby' || g.phase === 'ended') && now - this.lastActive > IDLE_MS) {
      for (const ws of [...this.sockets.keys()]) { try { ws.send(JSON.stringify({ type: 'idle' })); ws.close(4010, 'idle'); } catch (e) {} }
      return;
    }
    // 사진 찍기 2분이 지나도 안 돌아오면 그때부터 화면 꺼짐으로 봐요
    g.players.forEach(p => {
      if (p.photoAway && now > p.photoGraceUntil) { p.photoAway = false; p.away = true; p.connected = false; p.discAt = now; this.screenOff(p); }
    });
    if (g.vote && now >= g.vote.endsAt) { this.resolveVote(true); this.changed(); }
    if (g.phase === 'hiding' && now >= g.hideEndsAt) this.beginPlay();
    if (g.phase === 'playing') {
      g.players.forEach(p => {
        if (p.state !== 'out' && p.lat != null && (!p.trailAt || now - p.trailAt >= 5000)) { p.trailAt = now; p.trail.push([+p.lat.toFixed(6), +p.lng.toFixed(6), p.role === 'chaser' ? 1 : 0]); }
        if (p.state === 'out' || p.lat == null) return;
        // 오래 끊긴 사람은 자동 탈락
        if (!p.connected && p.discAt != null && now - p.discAt >= S.autoOut * 1000) { this.setOut(p, '연결이 ' + dur(S.autoOut) + ' 넘게 끊김'); this.checkWin(); return; }
        if (p.escorting && p.connected) {
          const t = this.escortOf(p), nj = t && this.nearestJail(p);
          if (t && nj && nj.d <= S.jailRadius) this.jailNow(p, t, nj.jail);
        }
        // 경계 판정: 오차 큰 위치는 무시, 경계선 10m 여유, 5초 넘게 밖에 있어야 경고
        if (p.connected && p.state !== 'escort' && (p.acc == null || p.acc <= BAD_ACC)) {
          const outNow = !inPoly(p, g.area) && distToPolyM(p, g.area) > EDGE_MARGIN;
          if (outNow) {
            if (p.outCand == null) p.outCand = now;
            if (p.outsideAt == null) { if (now - p.outCand >= CONFIRM_MS) p.outsideAt = now; }
            else if (now - p.outsideAt >= S.boundaryAllow * 1000) { this.setOut(p, '경기장 이탈'); return; }
          } else { p.outCand = null; if (p.outsideAt != null) { p.outsideAt = null; this.toast(p, '경기장으로 돌아왔어요'); } }
          if (p.state === 'jailed') {
            const j = g.jails.find(x => x.id === p.jailId);
            if (!j) { p.state = 'alive'; p.jailId = null; }
            else if (distM(p, j) <= S.jailRadius + EDGE_MARGIN) { p.jailGraceUntil = 0; p.jailCand = null; if (p.jailOutAt != null) { p.jailOutAt = null; this.toast(p, '감옥 안으로 돌아왔어요'); } }
            else if (p.jailGraceUntil > now) { /* 감옥까지 걸어오는 중 */ }
            else if (distM(p, j) > S.jailRadius + EDGE_MARGIN) {
              if (p.jailCand == null) p.jailCand = now;
              if (p.jailOutAt == null) { if (now - p.jailCand >= CONFIRM_MS) p.jailOutAt = now; }
              else if (now - p.jailOutAt >= S.boundaryAllow * 1000) { this.setOut(p, '감옥 이탈'); return; }
            } else { p.jailCand = null; if (p.jailOutAt != null) { p.jailOutAt = null; this.toast(p, '감옥 안으로 돌아왔어요'); } }
          } else { p.jailOutAt = null; p.jailCand = null; }
        }
        if (!p.connected && !p.publicByDisc && p.discAt != null && now - p.discAt >= S.disconnectAllow * 1000) {
          p.publicByDisc = true;
          this.notify(p, '내 위치가 공개됐어요', '화면이 너무 오래 꺼져 있었어요. 다시 켜면 숨겨져요', true);
          this.toastAll(p.name + '님 연결이 ' + dur(S.disconnectAllow) + ' 넘게 끊겨서 마지막 위치가 공개됐어요', p.id);
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
          rt.inmates.forEach(q => { q.state = 'alive'; q.jailId = null; q.jailOutAt = null; q.jailCand = null; q.protectUntil = now + 10000; this.toast(q, p.name + '님이 구출했어요! 10초 동안은 안 잡혀요. 도망쳐요'); });
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
      if (v.late || p.late) return;
      if (p === v) { if (p.lat != null) tokens.push({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, kind: 'me', acc: p.acc }); return; }
      if (!inGame && g.phase !== 'lobby') return;
      if (!pos) return;
      const base = { id: p.id, name: p.name, lat: pos.lat, lng: pos.lng, disc: !p.connected, jailed: p.state === 'jailed', escort: p.state === 'escort' };
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
      jailIndex: v.jailId ? g.jails.findIndex(j => j.id === v.jailId) + 1 : 0,
      escort: null, busy: false, late: !!v.late,
      protectLeft: v.protectUntil > now ? (v.protectUntil - now) / 1000 : 0,
      radar: null
    };
    // 레이더 (잡는 쪽만): 근처 잡을 수 있는 상대의 거리·방위만 보내요. 화면엔 안 그리고 소리·신호 막대로만 써요
    if ((S.radarRangeOn || S.radarSightOn) && playing && v.role === 'chaser' && v.state === 'alive' && v.lat != null && !(v.freezeUntil > now)) {
      const maxD = Math.max(S.radarRangeOn ? S.radarRangeDist : 0, S.radarSightOn ? S.radarSightDist : 0);
      me.radar = [];
      g.players.forEach(p => {
        if (p.role !== 'runner' || p.state !== 'alive' || p.protectUntil > now) return;
        const pos = p.connected ? p : p.known; if (!pos || pos.lat == null) return;
        const d = distM(v, pos); if (d > maxD) return;
        const toR = Math.PI / 180, la1 = v.lat * toR, la2 = pos.lat * toR, dl = (pos.lng - v.lng) * toR;
        const b = (Math.atan2(Math.sin(dl) * Math.cos(la2), Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl)) / toR + 360) % 360;
        me.radar.push({ d: Math.round(d), b: Math.round(b) });
      });
    }
    // 연행 정보: 도둑은 따라갈 경찰 위치, 경찰은 데려갈 도둑과 감옥까지 거리
    const pairOf = v.state === 'escort' ? g.players.find(x => x.id === v.escortBy) : this.escortOf(v);
    if (pairOf) {
      const police = v.state === 'escort' ? pairOf : v;
      const ppos = police.connected ? police : (police.known || police);
      const opos = pairOf.connected ? pairOf : (pairOf.known || pairOf);
      const nj = ppos && ppos.lat != null ? this.nearestJail(ppos) : null;
      me.escort = {
        role: v.state === 'escort' ? 'thief' : 'police', name: pairOf.name, connected: pairOf.connected,
        lat: opos && opos.lat != null ? opos.lat : null, lng: opos && opos.lat != null ? opos.lng : null,
        dist: Math.round(distM(v, opos)),
        jailIndex: nj ? g.jails.indexOf(nj.jail) + 1 : 0, jailDist: nj ? Math.round(nj.d) : null,
        jail: nj ? [nj.jail.lat, nj.jail.lng] : null, canJail: !!nj && nj.d <= S.jailRadius + 25
      };
      me.busy = v.state !== 'escort';
    }
    const runners = g.players.filter(p => p.role === 'runner');
    const alive = S.mode === 'cops' ? runners.filter(p => p.state === 'alive' || p.state === 'pending').length : runners.filter(p => p.state !== 'out').length;
    const out = {
      type: 'state', now, code: g.code, phase: g.phase, settings: S,
      hideEndsAt: g.hideEndsAt, endsAt: g.endsAt, area: g.area, jails: g.jails.map(j => [j.lat, j.lng]),
      players: g.players.map(p => ({ id: p.id, name: p.name, host: p.host, wish: p.wish, role: g.phase === 'lobby' ? null : p.role, state: p.state, connected: p.connected, hasPos: p.lat != null, checked: !!p.checked, push: !!p.push, late: !!p.late, discFor: !p.connected && p.discAt ? Math.round((now - p.discAt) / 1000) : 0 })),
      vote: g.vote ? (() => { const t = g.players.find(x => x.id === g.vote.target), b = g.players.find(x => x.id === g.vote.by); return { id: g.vote.id, targetId: g.vote.target, targetName: t ? t.name : '?', byName: b ? b.name : '?', left: Math.max(0, (g.vote.endsAt - now) / 1000), yes: g.vote.yes.length, no: g.vote.no.length, total: g.vote.voters.length, need: Math.floor(g.vote.voters.length / 2) + 1, canVote: g.vote.voters.includes(v.id), myVote: g.vote.yes.includes(v.id) ? 'yes' : g.vote.no.includes(v.id) ? 'no' : null, isTarget: g.vote.target === v.id, targetConnected: t ? t.connected : false }; })() : null,
      me, tokens, alive, catchCount: g.catchCount,
      reports: v.role === 'chaser' && v.state !== 'out' && playing ? g.reports.map(r => { const p = g.players.find(x => x.id === r.from); return p ? { id: r.id, name: p.name, dist: Math.round(distM(v, p.connected ? p : (p.known || p))) } : null; }).filter(Boolean) : [],
      album: this.canViewPhotos(v) || g.phase === 'ended' ? g.album : [],
      canViewPhotos: this.canViewPhotos(v),
      winner: g.winner, winReason: g.winReason, lastChaser: g.lastChaser || null
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
