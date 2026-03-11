const { verifyToken } = require('./auth');

// All connected players: { socketId: { id, username, x, y, z, rx, ry } }
const players = {};

function setupSocket(io) {
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
    };

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

        socket.broadcast.emit('playerMoved', {
          socketId: socket.id,
          x: data.x,
          y: data.y,
          z: data.z,
          rx: data.rx,
          ry: data.ry,
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
