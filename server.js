'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PICK_SECONDS = 15;
const REVEAL_MS = 3000;
const SCOREBOARD_MS = 1800;
const RECONNECT_GRACE_MS = 30_000;
const ROOM_IDLE_MS = 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const app = express();
app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'vault-rush',
    uptime: Math.floor(process.uptime())
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h',
  index: 'index.html'
}));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 8 * 1024 });
const rooms = new Map();

function makeToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function safeName(value) {
  if (typeof value !== 'string') return 'PLAYER';
  const name = value.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return name || 'PLAYER';
}

function touch(room) {
  room.lastActivity = Date.now();
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

function getPlayer(room, playerId) {
  return room.players.find(player => player.id === playerId);
}

function roleFor(room, player, round = room.round) {
  if (!room.players.length || !player) return null;
  const thiefSeat = round % 2 === 1 ? 0 : 1;
  return room.players[thiefSeat] &&
    room.players[thiefSeat].id === player.id
    ? 'thief'
    : 'guard';
}

function publicState(room, player) {
  const role = roleFor(room, player);
  const liveStatus = room.status;
  const roundStatus = liveStatus === 'opponentDisconnected'
    ? room.pausedStatus
    : liveStatus;
  const remainingMs = roundStatus === 'pick' && room.deadlineAt
    ? Math.max(0, room.deadlineAt - Date.now())
    : 0;
  const resultIsPublic = ['reveal', 'scoreboard', 'gameover'].includes(roundStatus);
  const ownPick = roundStatus === 'pick' && room.picks
    ? room.picks[role] && room.picks[role].playerId === player.id
      ? {
          index: room.picks[role].index,
          power: room.picks[role].power,
          auto: !!room.picks[role].auto
        }
      : null
    : null;

  return {
    type: 'state',
    room: room.code,
    status: liveStatus,
    pausedStatus: liveStatus === 'opponentDisconnected'
      ? room.pausedStatus
      : null,
    opponentGraceUntil: room.opponentGraceUntil || null,
    round: room.round,
    totalRounds: 6,
    suddenDeath: room.round > 6,
    role,
    playerId: player.id,
    players: room.players.map(item => ({
      id: item.id,
      name: item.name,
      connected: item.connected,
      ready: item.ready,
      rematch: item.rematch,
      score: item.score,
      powerUsed: item.powerUsed,
      stats: { ...item.stats }
    })),
    board: room.board ? room.board.slice() : null,
    deadlineAt: roundStatus === 'pick' ? room.deadlineAt : null,
    serverNow: Date.now(),
    remainingMs,
    myPick: ownPick,
    opponentLocked: roundStatus === 'pick' && room.picks
      ? !!room.picks[role === 'thief' ? 'guard' : 'thief']
      : false,
    history: room.history.map(entry => ({ ...entry })),
    reveal: resultIsPublic ? room.lastReveal : null,
    winnerId: roundStatus === 'gameover' ? room.winnerId : null,
    opponentLeft: !!room.opponentLeft
  };
}

function broadcast(room) {
  touch(room);
  for (const player of room.players) {
    if (player.ws && player.connected) {
      send(player.ws, publicState(room, player));
    }
  }
}

function sendWelcome(room, player) {
  send(player.ws, {
    type: 'welcome',
    room: room.code,
    token: player.token,
    playerId: player.id,
    name: player.name
  });
}

function makePlayer(name) {
  return {
    id: crypto.randomUUID(),
    token: makeToken(),
    name: safeName(name),
    ws: null,
    connected: false,
    disconnectedAt: null,
    graceTimer: null,
    expired: false,
    ready: false,
    rematch: false,
    score: 0,
    powerUsed: false,
    stats: { heists: 0, catches: 0, powerUses: 0 }
  };
}

function newRoom(firstName) {
  const code = makeCode();
  const room = {
    code,
    players: [makePlayer(firstName)],
    status: 'lobby',
    pausedStatus: null,
    pausedRemaining: null,
    pausedAction: null,
    board: null,
    round: 0,
    picks: null,
    history: [],
    lastReveal: null,
    winnerId: null,
    deadlineAt: null,
    pickTimer: null,
    tickTimer: null,
    phaseTimer: null,
    phaseDeadline: null,
    phaseAction: null,
    opponentGraceUntil: null,
    opponentLeft: false,
    lastActivity: Date.now()
  };
  rooms.set(code, room);
  return { room, player: room.players[0] };
}

function stopPickClock(room) {
  if (room.pickTimer) clearTimeout(room.pickTimer);
  if (room.tickTimer) clearInterval(room.tickTimer);
  room.pickTimer = null;
  room.tickTimer = null;
}

function stopPhaseClock(room) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  room.phaseTimer = null;
  room.phaseDeadline = null;
}

function randomBoard() {
  const values = [1, 5];

  for (let index = 0; index < 7; index += 1) {
    values.push(crypto.randomInt(2, 5));
  }

  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(0, index + 1);
    [values[index], values[swap]] = [values[swap], values[index]];
  }

  return values;
}

function chooseRandomIndex() {
  return crypto.randomInt(0, 9);
}

function armPickClock(room, durationMs = PICK_SECONDS * 1000) {
  stopPickClock(room);
  room.deadlineAt = Date.now() + durationMs;

  room.pickTimer = setTimeout(() => {
    if (room.status !== 'pick' || !room.picks) return;

    for (const role of ['thief', 'guard']) {
      if (!room.picks[role]) {
        const player = room.players.find(item => roleFor(room, item) === role);
        room.picks[role] = {
          playerId: player.id,
          index: chooseRandomIndex(),
          power: false,
          auto: true
        };
      }
    }

    resolveRound(room);
  }, durationMs);

  room.tickTimer = setInterval(() => {
    if (room.status === 'pick') broadcast(room);
  }, 1000);
}

function schedulePhase(room, delayMs, action) {
  stopPhaseClock(room);
  room.phaseAction = action;
  room.phaseDeadline = Date.now() + delayMs;

  room.phaseTimer = setTimeout(() => {
    room.phaseTimer = null;
    room.phaseDeadline = null;
    const next = room.phaseAction;
    room.phaseAction = null;

    if (next && room.status !== 'opponentDisconnected' &&
        room.status !== 'opponentLeft') {
      next();
    }
  }, delayMs);
}

function beginRound(room, roundNumber) {
  if (room.status === 'opponentLeft') return;

  stopPhaseClock(room);
  stopPickClock(room);

  room.round = roundNumber;
  room.board = randomBoard();
  room.picks = { thief: null, guard: null };
  room.lastReveal = null;
  room.status = 'pick';
  room.pausedStatus = null;
  room.deadlineAt = null;

  armPickClock(room);
  broadcast(room);
}

function resolveRound(room) {
  if (room.status !== 'pick' || !room.picks ||
      !room.picks.thief || !room.picks.guard) {
    return;
  }

  stopPickClock(room);

  const thiefPick = room.picks.thief;
  const guardPick = room.picks.guard;
  const thief = getPlayer(room, thiefPick.playerId);
  const guard = getPlayer(room, guardPick.playerId);
  const loot = room.board[thiefPick.index];
  const highestValue = Math.max(...room.board);
  const ghost = thiefPick.power && loot === highestValue;
  const lockdown = guardPick.power && loot >= 4;
  let outcome;
  let thiefDelta = 0;
  let guardDelta = 0;

  if (lockdown) {
    outcome = 'LOCKDOWN';
    thiefDelta = Math.floor(loot / 2);
  } else if (thiefPick.index === guardPick.index && !ghost) {
    outcome = 'CAUGHT';
    guardDelta = 2;
  } else {
    outcome = 'HEIST_SUCCESS';
    thiefDelta = loot;
  }

  thief.score += thiefDelta;
  guard.score += guardDelta;

  if (thiefDelta > 0) thief.stats.heists += 1;
  if (guardDelta > 0) guard.stats.catches += 1;
  if (thiefPick.power) thief.stats.powerUses += 1;
  if (guardPick.power) guard.stats.powerUses += 1;

  room.history.push({
    round: room.round,
    suddenDeath: room.round > 6,
    thiefId: thief.id,
    guardId: guard.id,
    thiefIndex: thiefPick.index,
    guardIndex: guardPick.index,
    loot,
    outcome,
    thiefDelta,
    guardDelta,
    thiefAuto: !!thiefPick.auto,
    guardAuto: !!guardPick.auto,
    ghost: !!thiefPick.power,
    lockdown: !!guardPick.power
  });

  room.lastReveal = { ...room.history[room.history.length - 1] };
  room.status = 'reveal';
  room.deadlineAt = null;
  broadcast(room);

  schedulePhase(room, REVEAL_MS, () => {
    room.status = 'scoreboard';
    broadcast(room);

    schedulePhase(room, SCOREBOARD_MS, () => {
      if (room.round < 6) {
        beginRound(room, room.round + 1);
        return;
      }

      if (room.round === 6 && thief.score === guard.score) {
        beginRound(room, 7);
        return;
      }

      if (room.round > 6 && thief.score === guard.score) {
        beginRound(room, room.round + 1);
        return;
      }

      room.status = 'gameover';
      room.winnerId = thief.score > guard.score ? thief.id : guard.id;
      broadcast(room);
    });
  });
}

function pauseRoom(room) {
  if (room.status === 'opponentDisconnected' || room.status === 'opponentLeft') {
    return;
  }

  room.pausedStatus = room.status;

  if (room.status === 'pick') {
    room.pausedRemaining = Math.max(
      0,
      (room.deadlineAt || Date.now()) - Date.now()
    );
    room.pausedAction = 'pick';
    stopPickClock(room);
  } else if (room.phaseTimer) {
    room.pausedRemaining = Math.max(
      0,
      (room.phaseDeadline || Date.now()) - Date.now()
    );
    room.pausedAction = 'phase';
    stopPhaseClock(room);
  } else {
    room.pausedRemaining = null;
    room.pausedAction = null;
  }

  room.status = 'opponentDisconnected';
}

function resumeRoom(room) {
  if (!room.pausedStatus || room.status !== 'opponentDisconnected') return;

  room.status = room.pausedStatus;
  const remaining = room.pausedRemaining;
  const action = room.pausedAction;

  room.pausedStatus = null;
  room.pausedRemaining = null;
  room.pausedAction = null;

  if (action === 'pick' && room.status === 'pick') {
    armPickClock(room, Math.max(0, remaining || 0));
  } else if (action === 'phase' && room.phaseAction) {
    schedulePhase(room, Math.max(0, remaining || 0), room.phaseAction);
  }
}

function markDisconnected(room, player, ws) {
  if (player.ws !== ws) return;

  player.ws = null;
  player.connected = false;
  player.disconnectedAt = Date.now();
  room.opponentGraceUntil = Date.now() + RECONNECT_GRACE_MS;

  pauseRoom(room);
  broadcast(room);

  if (player.graceTimer) clearTimeout(player.graceTimer);
  player.graceTimer = setTimeout(() => {
    if (player.connected || player.expired) return;

    player.expired = true;
    room.opponentLeft = true;
    stopPickClock(room);
    stopPhaseClock(room);
    room.status = 'opponentLeft';
    room.pausedStatus = null;
    room.opponentGraceUntil = null;
    broadcast(room);
  }, RECONNECT_GRACE_MS);
}

function bindPlayer(room, player, ws) {
  if (player.graceTimer) clearTimeout(player.graceTimer);

  player.graceTimer = null;
  player.ws = ws;
  player.connected = true;
  player.disconnectedAt = null;
  ws.playerId = player.id;
  ws.roomCode = room.code;
  room.opponentGraceUntil = null;

  if (room.players.every(item => item.connected)) resumeRoom(room);

  touch(room);
  sendWelcome(room, player);
  broadcast(room);
}

function createPlayer(ws, name) {
  const { room, player } = newRoom(name);
  bindPlayer(room, player, ws);
}

function joinRoom(ws, code, name) {
  if (typeof code !== 'string' || !/^[A-Z]{4}$/.test(code)) {
    sendError(ws, 'INVALID_CODE', 'Enter a room code with four uppercase letters.');
    return;
  }

  const room = rooms.get(code);

  if (!room) {
    sendError(ws, 'ROOM_NOT_FOUND', 'That room was not found. Check the code and try again.');
    return;
  }

  if (room.status === 'opponentLeft' || room.players.length >= 2) {
    sendError(ws, 'ROOM_FULL', 'This room already has two players.');
    return;
  }

  if (room.players.some(player => player.connected)) {
    const player = makePlayer(name);
    room.players.push(player);
    room.status = 'ready';
    bindPlayer(room, player, ws);
  } else {
    sendError(ws, 'ROOM_FULL', 'The room cannot accept another player right now.');
  }
}

function rejoinRoom(ws, code, token) {
  if (typeof code !== 'string' || !/^[A-Z]{4}$/.test(code) ||
      typeof token !== 'string') {
    sendError(ws, 'REJOIN_FAILED', 'This saved invite is incomplete. Join with a room code instead.');
    return;
  }

  const room = rooms.get(code);
  const player = room && room.players.find(item => item.token === token);

  if (!player || player.expired ||
      (player.disconnectedAt &&
       Date.now() - player.disconnectedAt > RECONNECT_GRACE_MS)) {
    sendError(ws, 'REJOIN_EXPIRED', 'Your 30-second reconnect window has expired. Create or join another room.');
    return;
  }

  if (player.ws && player.ws !== ws) {
    try {
      player.ws.close(4001, 'Replaced by a reconnecting session');
    } catch {
      // The old socket has already closed.
    }
  }

  bindPlayer(room, player, ws);
}

function handleIntent(ws, message) {
  if (!message || typeof message !== 'object' ||
      Array.isArray(message) || typeof message.type !== 'string') {
    sendError(ws, 'INVALID_MESSAGE', 'That message was not understood.');
    return;
  }

  if (message.type === 'pulse') {
    const activeRoom = rooms.get(ws.roomCode);
    if (activeRoom) touch(activeRoom);
    send(ws, { type: 'pulse' });
    return;
  }

  if (message.type === 'create') {
    if (ws.roomCode) {
      return sendError(ws, 'ALREADY_IN_ROOM', 'You are already in a room.');
    }
    createPlayer(ws, message.name);
    return;
  }

  if (message.type === 'join') {
    if (ws.roomCode) {
      return sendError(ws, 'ALREADY_IN_ROOM', 'You are already in a room.');
    }
    joinRoom(ws, message.room, message.name);
    return;
  }

  if (message.type === 'rejoin') {
    if (ws.roomCode) {
      return sendError(ws, 'ALREADY_IN_ROOM', 'You are already in a room.');
    }
    rejoinRoom(ws, message.room, message.token);
    return;
  }

  const room = rooms.get(ws.roomCode);
  const player = room && getPlayer(room, ws.playerId);

  if (!room || !player || !player.connected) {
    sendError(ws, 'NOT_IN_ROOM', 'Join a room before sending game actions.');
    return;
  }

  touch(room);

  if (message.type === 'ready') {
    if (room.status !== 'ready') {
      return sendError(ws, 'WRONG_PHASE', 'The room is not waiting for ready actions.');
    }

    player.ready = true;

    if (room.players.length === 2 &&
        room.players.every(item => item.ready && item.connected)) {
      beginRound(room, 1);
    } else {
      broadcast(room);
    }
    return;
  }

  if (message.type === 'pick') {
    if (room.status !== 'pick') {
      return sendError(ws, 'WRONG_PHASE', 'Picks are closed for this round.');
    }

    const role = roleFor(room, player);

    if (!Number.isInteger(message.index) ||
        message.index < 0 || message.index > 8) {
      return sendError(ws, 'INVALID_PICK', 'Choose one vault from the 3 by 3 grid.');
    }

    if (room.picks[role]) {
      return sendError(ws, 'DUPLICATE_PICK', 'Your pick is already locked for this round.');
    }

    if (typeof message.power !== 'boolean') {
      return sendError(ws, 'INVALID_POWER', 'The power-up choice was not understood.');
    }

    if (message.power && player.powerUsed) {
      return sendError(ws, 'POWER_USED', 'Your one power-up has already been used.');
    }

    room.picks[role] = {
      playerId: player.id,
      index: message.index,
      power: message.power,
      auto: false
    };

    if (message.power) player.powerUsed = true;

    if (room.picks.thief && room.picks.guard) {
      resolveRound(room);
    } else {
      broadcast(room);
      send(ws, {
        type: 'notice',
        message: 'Locked in. Waiting for opponent...',
        kind: 'locked'
      });
    }
    return;
  }

  if (message.type === 'rematch') {
    if (room.status !== 'gameover') {
      return sendError(ws, 'WRONG_PHASE', 'A rematch is available after the game ends.');
    }

    player.rematch = true;

    if (room.players.every(item => item.rematch && item.connected)) {
      for (const item of room.players) {
        item.score = 0;
        item.powerUsed = false;
        item.ready = true;
        item.rematch = false;
        item.stats = { heists: 0, catches: 0, powerUses: 0 };
      }

      room.history = [];
      room.lastReveal = null;
      room.winnerId = null;
      room.opponentLeft = false;
      beginRound(room, 1);
    } else {
      broadcast(room);
      send(ws, {
        type: 'notice',
        message: 'Rematch requested. Waiting for the other player...',
        kind: 'rematch'
      });
    }
    return;
  }

  sendError(ws, 'INVALID_MESSAGE', 'That action is not available in this game state.');
}

wss.on('connection', ws => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', data => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      sendError(ws, 'INVALID_JSON', 'Message must be valid JSON.');
      return;
    }
    handleIntent(ws, message);
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    const player = room && getPlayer(room, ws.playerId);
    if (room && player) markDisconnected(room, player, ws);
  });

  ws.on('error', () => {
    // The close handler owns reconnect and room state changes.
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 20_000);

const cleanup = setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms) {
    if (now - room.lastActivity < ROOM_IDLE_MS) continue;

    stopPickClock(room);
    stopPhaseClock(room);

    for (const player of room.players) {
      if (player.graceTimer) clearTimeout(player.graceTimer);
    }

    rooms.delete(code);
  }
}, 5 * 60_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('VAULT RUSH listening on port ' + PORT);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(cleanup);

  for (const room of rooms.values()) {
    stopPickClock(room);
    stopPhaseClock(room);

    for (const player of room.players) {
      if (player.graceTimer) clearTimeout(player.graceTimer);
    }
  }

  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);