const { verifyToken } = require('./auth');
const fs = require('fs');
const path = require('path');

// All connected players: { socketId: { id, username, x, y, z, rx, ry } }
const players = {};

// Game world time management
const GAME_STATE_FILE = path.join(__dirname, 'gameState.json');
const TIME_CYCLE_MILLISECONDS = 2 * 60 * 60 * 1000; // 2 real hours = 1 full day cycle

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

    // Initialize player at spawn
    players[socket.id] = {
      id: socket.user.id,
      username: socket.user.username,
      x: 0,
      y: 50,
      z: 0,
      rx: 0,
      ry: 0,
      isSwimming: false,
      isJumping: false,
      isRunning: false,
    };

    // Send game world time to the new player
    socket.emit('gameWorldTime', {
      worldStartTime: gameWorldStartTime,
      currentTime: getCurrentGameTime(),
    });

    // Send current players to the new player
    socket.emit('currentPlayers', players);

    // Notify others about new player
    socket.broadcast.emit('playerJoined', {
      socketId: socket.id,
      ...players[socket.id],
    });

    // Handle position updates
    socket.on('playerMove', (data) => {
      if (players[socket.id]) {
        players[socket.id].x = data.x;
        players[socket.id].y = data.y;
        players[socket.id].z = data.z;
        players[socket.id].rx = data.rx;
        players[socket.id].ry = data.ry;
        players[socket.id].isSwimming = !!data.isSwimming;
        players[socket.id].isJumping = !!data.isJumping;
        players[socket.id].isRunning = !!data.isRunning;

        socket.broadcast.emit('playerMoved', {
          socketId: socket.id,
          x: data.x,
          y: data.y,
          z: data.z,
          rx: data.rx,
          ry: data.ry,
          isSwimming: !!data.isSwimming,
          isJumping: !!data.isJumping,
          isRunning: !!data.isRunning,
        });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Player disconnected: ${socket.user.username} (${socket.id})`);
      delete players[socket.id];
      io.emit('playerLeft', socket.id);
    });
  });
}

module.exports = { setupSocket };
