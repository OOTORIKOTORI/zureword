const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const rooms = new Map();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const httpServer = app.listen(process.env.PORT || 3000, () => {
  console.log('Listening on port', process.env.PORT || 3000);
});
const wss = new WebSocketServer({ server: httpServer });

// ─── Game Data ────────────────────────────────────────────────────────────────

const ADJ = [
  'かっこいい','かわいい','赤い','おいしい','エモい','怖い','面白い','悲しい',
  'やさしい','強い','クールな','ヤバい','尊い','懐かしい','不思議な','最強の',
  '弱そうな','派手な','地味な','おしゃれな','古い','新しい','悪い','明るい',
  '暗い','重い','軽い','高い','低い','速い','遅い','大きい','小さい'
];

const BASE_THEMES = [
  { name: '食べ物',       s: 1 },
  { name: '動物',         s: 1 },
  { name: 'スポーツ',     s: 1 },
  { name: '国',           s: 1 },
  { name: '乗り物',       s: 1 },
  { name: '漫画タイトル', s: 2 },
  { name: '映画',         s: 2 },
  { name: 'ゲームキャラ', s: 2 },
  { name: 'ブランド',     s: 2 },
  { name: 'アニメキャラ', s: 2 },
  { name: 'SNS有名人',    s: 3 },
  { name: '海外芸能人',   s: 3 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rndStr(n) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function bcast(room, msg, skip = null) {
  const s = JSON.stringify(msg);
  for (const [id, p] of room.players) {
    if (id !== skip && p.ws.readyState === 1) p.ws.send(s);
  }
}

function pubPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, score: p.score, isHost: p.id === room.hostId
  }));
}

function clearTimers(room) {
  if (room.cdTimer)  { clearTimeout(room.cdTimer);  room.cdTimer  = null; }
  if (room.ansTimer) { clearTimeout(room.ansTimer); room.ansTimer = null; }
}

function sampleThemes(n) {
  const shuffled = [...BASE_THEMES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).map(t => ({ ...t }));
}

// ─── Game Logic ───────────────────────────────────────────────────────────────

function startRound(room) {
  room.round++;
  room.answers = new Map();
  room.votes   = new Map();
  for (const p of room.players.values()) { p.answered = false; p.voted = false; }

  const theme  = room.themes[Math.floor(Math.random() * room.themes.length)];
  const adj    = ADJ[Math.floor(Math.random() * ADJ.length)];
  room.curTheme = theme;
  room.curAdj   = adj;
  room.phase = 'countdown';

  bcast(room, {
    type: 'roundStart',
    round: room.round,
    totalRounds: room.totalRounds,
    theme, adj,
    isFinal: room.round === room.totalRounds
  });

  clearTimers(room);
  room.cdTimer = setTimeout(() => {
    room.phase = 'answer';
    bcast(room, { type: 'answerPhase', answerSec: room.answerSec });
    room.ansTimer = setTimeout(() => finalizeAnswers(room), room.answerSec * 1000);
  }, 8000);
}

function finalizeAnswers(room) {
  clearTimers(room);
  room.phase = 'voting';
  const answers = [...room.answers.entries()].map(([pid, v]) => ({
    pid, pn: room.players.get(pid)?.name ?? '?', v
  }));
  bcast(room, {
    type: 'votingPhase',
    answers,
    round: room.round,
    theme: room.curTheme,
    adj: room.curAdj,
    isFinal: room.round === room.totalRounds
  });
}

function finalizeVotes(room) {
  room.phase = 'round_result';

  const answers = [...room.answers.entries()].map(([pid, v]) => ({ pid, v }));
  const cnt = {};
  for (const a of answers) {
    const k = a.v.trim().toLowerCase();
    cnt[k] = (cnt[k] || 0) + 1;
  }

  const mult = room.round === room.totalRounds ? 2 : 1;
  const base = 1 + room.curTheme.s;
  const rs = {};
  for (const p of room.players.values()) rs[p.id] = 0;
  for (const a of answers) {
    if (cnt[a.v.trim().toLowerCase()] === 1) rs[a.pid] = base * mult;
  }

  // 投票ボーナス
  const vc = {};
  for (const [, t] of room.votes) if (t) vc[t] = (vc[t] || 0) + 1;
  const mv = Object.values(vc).length ? Math.max(...Object.values(vc)) : 0;
  if (mv > 0) {
    for (const [id, c] of Object.entries(vc)) {
      if (c === mv) rs[id] = (rs[id] || 0) + 1;
    }
  }

  for (const [id, pts] of Object.entries(rs)) {
    const p = room.players.get(id);
    if (p) p.score += pts;
  }

  const totalScores = {};
  for (const p of room.players.values()) totalScores[p.id] = p.score;

  bcast(room, {
    type: 'roundResult',
    roundScores: rs,
    totalScores,
    players: pubPlayers(room),
    round: room.round,
    totalRounds: room.totalRounds
  });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', ws => {
  let pid = null;
  let rid = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const room = rid ? rooms.get(rid) : null;

    switch (msg.type) {

      case 'create': {
        const name = (msg.name || '').trim().slice(0, 10);
        if (!name) return send(ws, { type: 'error', message: '名前を入力してください' });

        pid = rndStr(16);
        rid = rndStr(4);
        while (rooms.has(rid)) rid = rndStr(4);

        const player = { id: pid, name, ws, score: 0, used: new Set(), answered: false, voted: false, themeSubmitted: false };
        const r = {
          id: rid, hostId: pid, phase: 'lobby',
          players: new Map([[pid, player]]),
          totalRounds: 5,
          answerSec: 30,
          themePerPlayer: 2,
          commonThemeCount: 6,
          themes: sampleThemes(6),
          round: 0,
          curTheme: null, curAdj: null,
          answers: new Map(), votes: new Map(),
          cdTimer: null, ansTimer: null
        };
        r.totalRounds = [3, 5, 7].includes(msg.totalRounds) ? msg.totalRounds : 5;
        r.answerSec = [15, 30, 60].includes(msg.answerSec) ? msg.answerSec : 30;
        r.themePerPlayer = [0, 1, 2, 3, 5].includes(msg.themePerPlayer) ? msg.themePerPlayer : 2;
        r.commonThemeCount = (Number.isInteger(msg.commonThemeCount) && msg.commonThemeCount >= 0 && msg.commonThemeCount <= BASE_THEMES.length)
          ? msg.commonThemeCount
          : 6;
        r.themes = sampleThemes(r.commonThemeCount);
        rooms.set(rid, r);
        send(ws, {
          type: 'joined', pid, rid, isHost: true, players: pubPlayers(r),
          settings: {
            totalRounds: r.totalRounds,
            answerSec: r.answerSec,
            themePerPlayer: r.themePerPlayer,
            commonThemeCount: r.commonThemeCount,
          }
        });
        break;
      }

      case 'join': {
        const name = (msg.name || '').trim().slice(0, 10);
        const r = rooms.get((msg.rid || '').trim().toUpperCase());
        if (!name)  return send(ws, { type: 'error', message: '名前を入力してください' });
        if (!r)     return send(ws, { type: 'error', message: 'ルームが見つかりません' });
        if (r.phase !== 'lobby') return send(ws, { type: 'error', message: 'ゲームはすでに始まっています' });
        if (r.players.size >= 5) return send(ws, { type: 'error', message: '満員です（最大5人）' });

        pid = rndStr(16);
        rid = r.id;
        const player = { id: pid, name, ws, score: 0, used: new Set(), answered: false, voted: false, themeSubmitted: false };
        r.players.set(pid, player);
        send(ws, {
          type: 'joined', pid, rid, isHost: false, players: pubPlayers(r),
          settings: {
            totalRounds: r.totalRounds,
            answerSec: r.answerSec,
            themePerPlayer: r.themePerPlayer,
            commonThemeCount: r.commonThemeCount,
          }
        });
        bcast(r, { type: 'playerJoined', players: pubPlayers(r) }, pid);
        break;
      }

      case 'startTheme': {
        if (!room || room.hostId !== pid) return;
        if (room.players.size < 2) return send(ws, { type: 'error', message: '2人以上必要です' });
        room.phase = 'theme_submit';
        bcast(room, { type: 'themePhase', players: pubPlayers(room), themePerPlayer: room.themePerPlayer });
        break;
      }

      case 'submitThemes': {
        if (!room || room.phase !== 'theme_submit') return;
        const p = room.players.get(pid);
        if (!p || p.themeSubmitted) return;
        const themes = (msg.themes || []).map(t => (t || '').trim().slice(0, 20)).filter(Boolean).slice(0, room.themePerPlayer);
        for (const t of themes) room.themes.push({ name: t, s: 2 });
        p.themeSubmitted = true;
        const done = [...room.players.values()].filter(p => p.themeSubmitted).length;
        bcast(room, { type: 'themeProgress', done, total: room.players.size });
        if (done >= room.players.size) {
          room.phase = 'theme_review';
          bcast(room, { type: 'themeReview', themes: room.themes });
        }
        break;
      }

      case 'removeTheme': {
        if (!room || room.hostId !== pid || room.phase !== 'theme_review') return;
        room.themes = room.themes.filter(t => t.name !== msg.name);
        bcast(room, { type: 'themeReview', themes: room.themes });
        break;
      }

      case 'startGame': {
        if (!room || room.hostId !== pid || room.phase !== 'theme_review') return;
        if (room.themes.length < 1) {
          return send(ws, { type: 'error', message: 'テーマが1つ以上必要です' });
        }
        for (const p of room.players.values()) p.score = 0;
        startRound(room);
        break;
      }

      case 'submitAnswer': {
        if (!room || room.phase !== 'answer') return;
        const p = room.players.get(pid);
        if (!p || p.answered) return;
        const v = (msg.answer || '').trim().slice(0, 30);
        if (!v) return;
        if (p.used.has(v.toLowerCase())) return send(ws, { type: 'error', message: 'この回答はすでに使っています' });
        p.used.add(v.toLowerCase());
        p.answered = true;
        room.answers.set(pid, v);
        send(ws, { type: 'answerAccepted' });
        bcast(room, { type: 'answerProgress', count: room.answers.size, total: room.players.size });
        if (room.answers.size >= room.players.size) finalizeAnswers(room);
        break;
      }

      case 'vote': {
        if (!room || room.phase !== 'voting') return;
        const p = room.players.get(pid);
        if (!p || p.voted) return;
        const targetId = msg.targetId !== pid ? msg.targetId : null;
        p.voted = true;
        room.votes.set(pid, targetId || null);
        bcast(room, { type: 'voteProgress', count: room.votes.size, total: room.players.size });
        if (room.votes.size >= room.players.size) finalizeVotes(room);
        break;
      }

      case 'nextRound': {
        if (!room || room.hostId !== pid || room.phase !== 'round_result') return;
        if (room.round >= room.totalRounds) {
          room.phase = 'game_over';
          const finalScores = {};
          for (const p of room.players.values()) finalScores[p.id] = p.score;
          bcast(room, { type: 'gameOver', finalScores, players: pubPlayers(room) });
        } else {
          startRound(room);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!rid || !pid) return;
    const room = rooms.get(rid);
    if (!room) return;
    room.players.delete(pid);

    if (room.players.size === 0) {
      clearTimers(room);
      rooms.delete(rid);
      return;
    }

    if (room.hostId === pid) {
      room.hostId = room.players.keys().next().value;
    }
    bcast(room, { type: 'playerLeft', pid, players: pubPlayers(room) });

    // 抜けたプレイヤーの代わりに進行
    if (room.phase === 'answer' && !room.answers.has(pid)) {
      if (room.answers.size >= room.players.size) finalizeAnswers(room);
    }
    if (room.phase === 'voting' && !room.votes.has(pid)) {
      room.votes.set(pid, null);
      if (room.votes.size >= room.players.size) finalizeVotes(room);
    }
    if (room.phase === 'theme_submit') {
      const done = [...room.players.values()].filter(p => p.themeSubmitted).length;
      if (done >= room.players.size) {
        room.phase = 'theme_review';
        bcast(room, { type: 'themeReview', themes: room.themes });
      }
    }
  });
});


