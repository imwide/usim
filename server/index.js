const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const { router: authRouter } = require('./auth');
const { setupSocket } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/assets/character.glb', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'character.glb'));
});

// Routes
app.use('/api/auth', authRouter);

// Setup game socket
setupSocket(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`USIM server running on http://localhost:${PORT}`);
});
