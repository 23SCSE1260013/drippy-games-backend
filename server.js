require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const GameEngine = require('./gameEngine');

const app = express();
const server = http.createServer(app);

// ── SOCKET.IO ──
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST']
  }
});

// ── MIDDLEWARE ──
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json());
app.use(express.static('../frontend'));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth/', authLimiter);

// ── ROUTES ──
app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/game', require('./routes/game'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── GAME ENGINE ──
const engine = new GameEngine(io);

// ── SOCKET.IO HANDLERS ──
io.use(async (socket, next) => {
  // Optional auth — allow anonymous spectators
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');
      socket.user = user;
    } catch (e) {
      // invalid token — allow as guest
    }
  }
  next();
});

io.on('connection', (socket) => {
  const username = socket.user?.username || 'Guest';
  console.log(`[Socket] ${username} connected (${socket.id})`);

  // Send current game state immediately
  socket.emit('game:state', engine.getState());

  // ── PLACE BET ──
  socket.on('game:place_bet', async ({ amount, slot }) => {
    if (!socket.user) return socket.emit('error', { message: 'Login required to bet' });
    if (!amount || amount < 10) return socket.emit('error', { message: 'Minimum bet is ₹10' });
    if (amount > 50000) return socket.emit('error', { message: 'Maximum bet is ₹50,000' });
    if (engine.state !== 'waiting') return socket.emit('error', { message: 'Betting closed — wait for next round' });

    try {
      const user = await User.findById(socket.user._id);
      if (user.balance < amount) return socket.emit('error', { message: 'Insufficient balance' });

      const placed = engine.placeBet(socket.user._id, user.username, parseFloat(amount), slot || 1);
      if (!placed) return socket.emit('error', { message: 'Bet already placed for this slot' });

      // Deduct balance
      user.balance -= parseFloat(amount);
      user.lockedBalance += parseFloat(amount);
      user.addTransaction('bet', parseFloat(amount), 'completed',
        `Bet on round #${engine.roundId}`, { roundId: engine.roundId });
      await user.save();

      socket.emit('game:bet_confirmed', {
        slot, amount, newBalance: user.balance, roundId: engine.roundId
      });
    } catch (err) {
      console.error(err);
      socket.emit('error', { message: 'Server error placing bet' });
    }
  });

  // ── CASH OUT ──
  socket.on('game:cashout', async ({ slot }) => {
    if (!socket.user) return socket.emit('error', { message: 'Not authenticated' });
    if (engine.state !== 'flying') return socket.emit('error', { message: 'No active round' });

    try {
      const result = engine.cashOut(socket.user._id, slot || 1);
      if (!result) return socket.emit('error', { message: 'No active bet to cash out' });

      const user = await User.findById(socket.user._id);
      user.balance += result.winAmount;
      user.lockedBalance = Math.max(0, user.lockedBalance - result.betAmount);
      user.addTransaction('win', result.winAmount, 'completed',
        `Cashed out at ${result.multiplier}x on round #${engine.roundId}`,
        { roundId: engine.roundId, multiplier: result.multiplier }
      );
      await user.save();

      socket.emit('game:cashout_confirmed', {
        multiplier: result.multiplier,
        winAmount: result.winAmount,
        newBalance: user.balance
      });
    } catch (err) {
      console.error(err);
      socket.emit('error', { message: 'Server error cashing out' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] ${username} disconnected`);
  });
});

// ── MONGODB + START ──
const PORT = process.env.PORT || 4000;
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/drippygames')
  .then(async () => {
    console.log('[DB] MongoDB connected');
    await engine.init();
    server.listen(PORT, () => console.log(`[Server] Running on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  });

module.exports = { app, io };
