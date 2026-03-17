const { verifyToken } = require('./auth');
const db = require('./db');
const fs = require('fs');
const path = require('path');

// All connected players: { socketId: { id, username, x, y, z, rx, ry } }
const players = {};

const DEFAULT_SPAWN = Object.freeze({
  x: 0,
  y: 50,
  z: 0,
  rx: 0,
  ry: 0,
});

const getPlayerPositionStmt = db.prepare(`
  SELECT x, y, z, rx, ry
  FROM player_positions
  WHERE user_id = ?
`);

const savePlayerPositionStmt = db.prepare(`
  INSERT INTO player_positions (user_id, x, y, z, rx, ry)
  VALUES (@userId, @x, @y, @z, @rx, @ry)
  ON CONFLICT(user_id) DO UPDATE SET
    x = excluded.x,
    y = excluded.y,
    z = excluded.z,
    rx = excluded.rx,
    ry = excluded.ry,
    updated_at = CURRENT_TIMESTAMP
`);

// Game world time management
const GAME_STATE_FILE = path.join(__dirname, 'gameState.json');
const TIME_CYCLE_MILLISECONDS = 2 * 60 * 60 * 1000; // 2 real hours = 1 full day cycle

function coerceNumber(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizePosition(position = {}) {
  return {
    x: coerceNumber(position.x, DEFAULT_SPAWN.x),
    y: coerceNumber(position.y, DEFAULT_SPAWN.y),
    z: coerceNumber(position.z, DEFAULT_SPAWN.z),
    rx: coerceNumber(position.rx, DEFAULT_SPAWN.rx),
    ry: coerceNumber(position.ry, DEFAULT_SPAWN.ry),
  };
}

function loadPlayerPosition(userId) {
  const savedPosition = getPlayerPositionStmt.get(userId);
  return savedPosition ? normalizePosition(savedPosition) : null;
}

function persistPlayerPosition(userId, position) {
  const normalized = normalizePosition(position);
  savePlayerPositionStmt.run({ userId, ...normalized });
}

function removeExistingPlayerSessions(io, userId) {
  let latestPosition = null;

  for (const [socketId, player] of Object.entries(players)) {
    if (player.id !== userId) continue;

    latestPosition = normalizePosition(player);
    persistPlayerPosition(userId, player);
    delete players[socketId];
    io.emit('playerLeft', socketId);

    const existingSocket = io.sockets.sockets.get(socketId);
    if (existingSocket) {
      existingSocket.disconnect(true);
    }
  }

  return latestPosition;
}

function listOtherPlayers(currentSocketId) {
  const otherPlayers = {};

  for (const [socketId, player] of Object.entries(players)) {
    if (socketId === currentSocketId) continue;
    otherPlayers[socketId] = player;
  }

  return otherPlayers;
}

function loadGameState() {
  try {
    if (fs.existsSync(GAME_STATE_FILE)) {
      const data = fs.readFileSync(GAME_STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading game state:', err);
  }
  return null;
}

function saveGameState(state) {
  try {
    fs.writeFileSync(GAME_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Error saving game state:', err);
  }
}

let gameWorldStartTime = (() => {
  const savedState = loadGameState();
  if (savedState && savedState.worldStartTime) {
    console.log('Loaded existing game world start time');
    return savedState.worldStartTime;
  }
  // First time: use current time as the game world start
  const startTime = Date.now();
  saveGameState({ worldStartTime: startTime });
  console.log('Created new game world start time');
  return startTime;
})();

function getCurrentGameTime() {
  // Returns a value 0-1 representing the current position in the day cycle
  const elapsedMs = Date.now() - gameWorldStartTime;
  return (elapsedMs / TIME_CYCLE_MILLISECONDS) % 1.0;
}

function setupSocket(io) {
  // Send time updates to all clients every 5 seconds
  setInterval(() => {
    io.emit('gameTimeUpdate', {
      currentTime: getCurrentGameTime(),
    });
  }, 5000);
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    const user = verifyToken(token);
    if (!user) {
      return next(new Error('Invalid token'));
    }
    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.user.username} (${socket.id})`);

    const livePosition = removeExistingPlayerSessions(io, socket.user.id);
    const savedPosition = livePosition || loadPlayerPosition(socket.user.id);
    const spawnPosition = savedPosition || DEFAULT_SPAWN;

    // Initialize player at spawn
    players[socket.id] = {
      id: socket.user.id,
      username: socket.user.username,
      ...spawnPosition,
      isSwimming: false,
      isFlying: false,
      isJumping: false,
      isRunning: false,
    };

    socket.emit('spawnPosition', spawnPosition);

    // Send game world time to the new player
    socket.emit('gameWorldTime', {
      worldStartTime: gameWorldStartTime,
      currentTime: getCurrentGameTime(),
    });

    // Send current players to the new player
    socket.emit('currentPlayers', listOtherPlayers(socket.id));

    // Notify others about new player
    socket.broadcast.emit('playerJoined', {
      socketId: socket.id,
      ...players[socket.id],
    });

    // Handle position updates
    socket.on('playerMove', (data) => {
      if (players[socket.id]) {
        const nextPosition = normalizePosition(data);

        players[socket.id].x = nextPosition.x;
        players[socket.id].y = nextPosition.y;
        players[socket.id].z = nextPosition.z;
        players[socket.id].rx = nextPosition.rx;
        players[socket.id].ry = nextPosition.ry;
        players[socket.id].isSwimming = !!data.isSwimming;
        players[socket.id].isFlying = !!data.isFlying;
        players[socket.id].isJumping = !!data.isJumping;
        players[socket.id].isRunning = !!data.isRunning;

        socket.broadcast.emit('playerMoved', {
          socketId: socket.id,
          ...nextPosition,
          isSwimming: !!data.isSwimming,
          isFlying: !!data.isFlying,
          isJumping: !!data.isJumping,
          isRunning: !!data.isRunning,
        });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Player disconnected: ${socket.user.username} (${socket.id})`);
      const player = players[socket.id];
      if (!player) return;

      persistPlayerPosition(socket.user.id, player);
      delete players[socket.id];
      io.emit('playerLeft', socket.id);
    });
  });
}

module.exports = { setupSocket };
