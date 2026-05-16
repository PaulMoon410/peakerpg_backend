const http = require('http');
const path = require('path');
const { URL } = require('url');
const { randomBytes, scryptSync, timingSafeEqual } = require('crypto');
const { spawnSync } = require('child_process');

const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://geocities.ws';
const ENFORCE_HTTPS = process.env.ENFORCE_HTTPS !== 'false';
const FTP_ROOT = process.env.PEAKE_FTP_ROOT || '/games/peake_rpg/saves';
const FTP_SCRIPT = path.join(__dirname, 'tools', 'ftp_store.py');

const sessions = new Map();
const worldPlayers = new Map();
const worldStreams = new Map();
const worldChat = [];

function sendJson(res, statusCode, payload, origin = FRONTEND_ORIGIN) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Token',
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeUsername(username) {
  if (typeof username !== 'string') return '';
  return username.trim().toLowerCase();
}

function validateUsername(username) {
  return /^[a-z0-9_-]{3,32}$/.test(username);
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: scryptSync(String(password), salt, 64).toString('hex'),
  };
}

function verifyPassword(password, account) {
  const candidate = scryptSync(String(password), account.passwordSalt, 64).toString('hex');
  const stored = Buffer.from(account.passwordHash, 'hex');
  const provided = Buffer.from(candidate, 'hex');
  if (stored.length !== provided.length) return false;
  return timingSafeEqual(stored, provided);
}

function remotePath(...segments) {
  return [FTP_ROOT, ...segments].join('/').replace(/\/+/g, '/');
}

function runFtp(action, remoteFilePath, content = '') {
  const result = spawnSync('python3', [FTP_SCRIPT, action, remoteFilePath], {
    input: content,
    encoding: 'utf8',
    env: {
      ...process.env,
      PEAKE_FTP_ROOT: FTP_ROOT,
    },
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();

  if (result.status !== 0) {
    throw new Error(stderr || stdout || `FTP helper failed for ${action}`);
  }

  try {
    return stdout ? JSON.parse(stdout) : { ok: true };
  } catch (error) {
    throw new Error(`FTP helper returned invalid JSON: ${stdout}`);
  }
}

function readRemoteJson(remoteFilePath) {
  const response = runFtp('read', remoteFilePath);
  if (!response.ok) {
    return null;
  }
  if (typeof response.content !== 'string' || !response.content.trim()) {
    return null;
  }
  return JSON.parse(response.content);
}

function writeRemoteJson(remoteFilePath, payload) {
  runFtp('write', remoteFilePath, JSON.stringify(payload, null, 2));
}

function sanitizeChatMessage(message) {
  return String(message || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function buildWorldSnapshot() {
  return {
    players: Array.from(worldPlayers.values()).sort((left, right) => left.username.localeCompare(right.username)),
    chat: worldChat.slice(-40),
    serverTime: new Date().toISOString(),
  };
}

function getPlayersInLocation(location) {
  return Array.from(worldPlayers.values())
    .filter((player) => player.location === location)
    .map((player) => player.username);
}

function sendWorldEventToUser(username, eventType, payload) {
  const stream = worldStreams.get(username);
  if (!stream) return;
  stream.res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcastToLocation(location, eventType, payload, excludeUsername = null) {
  const usernames = getPlayersInLocation(location);
  for (const username of usernames) {
    if (excludeUsername && username === excludeUsername) continue;
    sendWorldEventToUser(username, eventType, payload);
  }
}

function announceRoom(location, text, username = null, kind = "notice") {
  const payload = {
    kind,
    location,
    text,
    username,
    createdAt: new Date().toISOString(),
  };
  broadcastToLocation(location, 'room-message', payload);
}

function announceMove(previousLocation, nextLocation, username) {
  if (previousLocation && previousLocation !== nextLocation) {
    announceRoom(previousLocation, `${username} leaves the room.`, username, 'leave');
  }
  announceRoom(nextLocation, `${username} enters the room.`, username, 'enter');
}

function pushChatMessage(message) {
  worldChat.push(message);
  if (worldChat.length > 100) {
    worldChat.splice(0, worldChat.length - 100);
  }
}

function broadcastWorldEvent(eventType, payload) {
  const packet = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const stream of worldStreams.values()) {
    stream.res.write(packet);
  }
}

function upsertWorldPlayer(username, data = {}) {
  const previous = worldPlayers.get(username) || {
    username,
    location: 'spawn',
    roomName: 'Mysterious Chamber',
    status: 'online',
  };
  const next = {
    ...previous,
    ...data,
    username,
    updatedAt: new Date().toISOString(),
  };
  worldPlayers.set(username, next);
  return next;
}

function removeWorldPlayer(username) {
  worldPlayers.delete(username);
}

function issueSession(username) {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, {
    username,
    createdAt: Date.now(),
  });
  return token;
}

function getSessionFromRequest(req, body = {}) {
  const headerToken = String(req.headers['x-session-token'] || '').trim();
  const authorization = String(req.headers.authorization || '').trim();
  const bearerToken = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const token = headerToken || bearerToken || String(body.token || '').trim();

  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  return { token, ...session };
}

function getSessionFromUrl(req, url, body = {}) {
  const queryToken = url.searchParams.get('token') || '';
  if (queryToken) {
    const session = sessions.get(String(queryToken).trim());
    if (session) {
      return { token: String(queryToken).trim(), ...session };
    }
  }
  return getSessionFromRequest(req, body);
}

function createDefaultCharacter(username) {
  return {
    username,
    stats: {
      health: 100,
      coins: 10,
      strength: 5,
      agility: 5,
    },
    inventory: ['Map'],
  };
}

function createDefaultGameState(username) {
  return {
    username,
    location: 'spawn',
    log: [],
    updatedAt: new Date().toISOString(),
  };
}

function accountPaths(username) {
  return {
    account: remotePath('accounts', username, 'account.json'),
    character: remotePath('characters', username, 'character.json'),
    gameState: remotePath('game_state', username, 'game_state.json'),
  };
}

async function handleRequest(req, res) {
  const origin = req.headers.origin;
  const allowedOrigin = origin === FRONTEND_ORIGIN ? origin : FRONTEND_ORIGIN;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const isHttps = forwardedProto === 'https';
  const isLocalhost = req.headers.host && req.headers.host.startsWith('localhost');

  // Render terminates TLS at the edge and forwards protocol in x-forwarded-proto.
  if (ENFORCE_HTTPS && !isHttps && !isLocalhost && process.env.NODE_ENV === 'production') {
    sendJson(res, 426, {
      error: 'HTTPS required',
      message: 'Use the HTTPS endpoint for this API.',
    }, allowedOrigin);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Token',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'peake-api' }, allowedOrigin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ping') {
    sendJson(res, 200, {
      message: 'Peake API reachable',
      timestamp: new Date().toISOString(),
      ftpRoot: FTP_ROOT,
    }, allowedOrigin);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readRequestBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '').trim();

    if (!validateUsername(username)) {
      sendJson(res, 400, { error: 'Username must be 3-32 chars and use a-z, 0-9, _ or -.' }, allowedOrigin);
      return;
    }

    if (password.length < 4) {
      sendJson(res, 400, { error: 'Password must be at least 4 characters.' }, allowedOrigin);
      return;
    }

    const paths = accountPaths(username);
    const existingAccount = readRemoteJson(paths.account);
    if (existingAccount) {
      sendJson(res, 409, { error: 'Account already exists.' }, allowedOrigin);
      return;
    }

    const passwordData = hashPassword(password);
    const now = new Date().toISOString();
    const account = {
      username,
      passwordSalt: passwordData.salt,
      passwordHash: passwordData.hash,
      createdAt: now,
      updatedAt: now,
    };

    writeRemoteJson(paths.account, account);
    writeRemoteJson(paths.character, createDefaultCharacter(username));
    writeRemoteJson(paths.gameState, createDefaultGameState(username));

    const token = issueSession(username);
    sendJson(res, 201, { ok: true, username, token }, allowedOrigin);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readRequestBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '').trim();

    if (!validateUsername(username)) {
      sendJson(res, 400, { error: 'Invalid username.' }, allowedOrigin);
      return;
    }

    const paths = accountPaths(username);
    const account = readRemoteJson(paths.account);
    if (!account) {
      sendJson(res, 404, { error: 'Account not found.' }, allowedOrigin);
      return;
    }

    if (!verifyPassword(password, account)) {
      sendJson(res, 401, { error: 'Invalid password.' }, allowedOrigin);
      return;
    }

    const token = issueSession(username);
    sendJson(res, 200, { ok: true, username, token }, allowedOrigin);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/save') {
    const body = await readRequestBody(req);
    const session = getSessionFromRequest(req, body);

    if (!session) {
      sendJson(res, 401, { error: 'Login required.' }, allowedOrigin);
      return;
    }

    const paths = accountPaths(session.username);
    const character = body.character || {};
    const gameState = body.gameState || {};
    const savedAt = new Date().toISOString();

    const currentCharacter = {
      username: session.username,
      stats: character.stats || {},
      inventory: Array.isArray(character.inventory) ? character.inventory : [],
      meta: {
        savedAt,
      },
    };

    const currentGameState = {
      username: session.username,
      location: typeof gameState.location === 'string' ? gameState.location : 'spawn',
      log: Array.isArray(gameState.log) ? gameState.log : [],
      meta: {
        savedAt,
      },
    };

    writeRemoteJson(paths.character, currentCharacter);
    writeRemoteJson(paths.gameState, currentGameState);

    sendJson(res, 200, {
      ok: true,
      username: session.username,
      savedAt,
    }, allowedOrigin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/save') {
    const session = getSessionFromRequest(req);

    if (!session) {
      sendJson(res, 401, { error: 'Login required.' }, allowedOrigin);
      return;
    }

    const paths = accountPaths(session.username);
    const character = readRemoteJson(paths.character) || createDefaultCharacter(session.username);
    const gameState = readRemoteJson(paths.gameState) || createDefaultGameState(session.username);

    sendJson(res, 200, {
      ok: true,
      username: session.username,
      character,
      gameState,
    }, allowedOrigin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/world/state') {
    const session = getSessionFromUrl(req, url);

    if (!session) {
      sendJson(res, 401, { error: 'Login required.' }, allowedOrigin);
      return;
    }

    sendJson(res, 200, {
      ok: true,
      username: session.username,
      world: buildWorldSnapshot(),
    }, allowedOrigin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/world/stream') {
    const session = getSessionFromUrl(req, url);

    if (!session) {
      sendJson(res, 401, { error: 'Login required.' }, allowedOrigin);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': allowedOrigin,
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(buildWorldSnapshot())}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
    }, 25000);

    worldStreams.set(session.username, { res, heartbeat });

    req.on('close', () => {
      clearInterval(heartbeat);
      worldStreams.delete(session.username);
      if (worldPlayers.has(session.username)) {
        removeWorldPlayer(session.username);
        pushChatMessage({
          system: true,
          message: `${session.username} left the world.`,
          createdAt: new Date().toISOString(),
        });
        broadcastWorldEvent('snapshot', buildWorldSnapshot());
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/world/join') {
    const body = await readRequestBody(req);
    const session = getSessionFromUrl(req, url, body);

    if (!session) {
      sendJson(res, 401, { error: 'Login required.' }, allowedOrigin);
      return;
    }

    const player = upsertWorldPlayer(session.username, {
      location: typeof body.location === 'string' ? body.location : 'spawn',
      roomName: typeof body.roomName === 'string' ? body.roomName : 'Mysterious Chamber',
      status: 'online',
    });

    announceRoom(player.location, `${session.username} enters the room.`, session.username, 'enter');
    pushChatMessage({
      system: true,
      message: `${session.username} entered the world.`,
      createdAt: new Date().toISOString(),
    });
    broadcastWorldEvent('snapshot', buildWorldSnapshot());

    sendJson(res, 200, {
      ok: true,
      player,
      announcement: {
        kind: 'enter',
        location: player.location,
        text: `${session.username} enters the room.`,
        username: session.username,
      },
      world: buildWorldSnapshot(),
    }, allowedOrigin);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/world/update') {
    const body = await readRequestBody(req);
    const session = getSessionFromUrl(req, url, body);

    if (!session) {
      sendJson(res, 401, { error: 'Login required.' }, allowedOrigin);
      return;
    }

    const previousLocation = worldPlayers.get(session.username)?.location || null;
    const player = upsertWorldPlayer(session.username, {
      location: typeof body.location === 'string' ? body.location : 'spawn',
      roomName: typeof body.roomName === 'string' ? body.roomName : 'Unknown',
      status: 'online',
    });

    const currentLocation = player.location;
    if (previousLocation && previousLocation !== currentLocation) {
      announceRoom(previousLocation, `${session.username} leaves the room.`, session.username, 'leave');
    }
    if (!previousLocation || previousLocation !== currentLocation) {
      announceRoom(currentLocation, `${session.username} enters the room.`, session.username, 'enter');
    }

    broadcastWorldEvent('snapshot', buildWorldSnapshot());
    sendJson(res, 200, {
      ok: true,
      player,
      announcement: previousLocation && previousLocation !== currentLocation ? {
        kind: 'move',
        location: currentLocation,
        previousLocation,
        text: `${session.username} enters the room.`,
        username: session.username,
      } : null,
    }, allowedOrigin);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/world/chat') {
    const body = await readRequestBody(req);
    const session = getSessionFromUrl(req, url, body);

    if (!session) {
      sendJson(res, 401, { error: 'Login required.' }, allowedOrigin);
      return;
    }

    const message = sanitizeChatMessage(body.message);
    if (!message) {
      sendJson(res, 400, { error: 'Message is required.' }, allowedOrigin);
      return;
    }

    const chatEntry = {
      username: session.username,
      message,
      location: worldPlayers.get(session.username)?.location || 'spawn',
      createdAt: new Date().toISOString(),
    };
    pushChatMessage(chatEntry);
    announceRoom(chatEntry.location, `${session.username} says: ${message}`, session.username, 'chat');
    broadcastWorldEvent('snapshot', buildWorldSnapshot());
    sendJson(res, 200, {
      ok: true,
      chat: chatEntry,
      announcement: {
        kind: 'chat',
        location: chatEntry.location,
        text: `${session.username} says: ${message}`,
        username: session.username,
      },
    }, allowedOrigin);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/world/leave') {
    const body = await readRequestBody(req);
    const session = getSessionFromUrl(req, url, body);

    if (!session) {
      sendJson(res, 401, { error: 'Login required.' }, allowedOrigin);
      return;
    }

    if (worldStreams.has(session.username)) {
      clearInterval(worldStreams.get(session.username).heartbeat);
      worldStreams.delete(session.username);
    }
    if (worldPlayers.has(session.username)) {
      const previousLocation = worldPlayers.get(session.username).location;
      announceRoom(previousLocation, `${session.username} leaves the room.`, session.username, 'leave');
      removeWorldPlayer(session.username);
      pushChatMessage({
        system: true,
        message: `${session.username} left the world.`,
        createdAt: new Date().toISOString(),
      });
      broadcastWorldEvent('snapshot', buildWorldSnapshot());
    }

    sendJson(res, 200, {
      ok: true,
      announcement: {
        kind: 'leave',
        text: `${session.username} leaves the world.`,
        username: session.username,
      },
    }, allowedOrigin);
    return;
  }

  sendJson(res, 404, { error: 'Not found' }, allowedOrigin);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    const origin = req.headers.origin === FRONTEND_ORIGIN ? req.headers.origin : FRONTEND_ORIGIN;
    sendJson(res, 500, { error: error.message || 'Internal server error' }, origin);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Peake API running on http://0.0.0.0:${PORT}`);
  console.log(`Allowed frontend origin: ${FRONTEND_ORIGIN}`);
  console.log(`FTP root: ${FTP_ROOT}`);
});
