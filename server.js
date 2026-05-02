// ============================================================
//  DRIPPY GAMES — SINGLE-FILE BACKEND
//  Run: node server.js
//  Deps: npm install dotenv express socket.io mongoose cors
//        express-rate-limit express-validator jsonwebtoken bcryptjs
// ============================================================

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const { body, validationResult } = require('express-validator');

// ─────────────────────────────────────────────
//  MONGOOSE SCHEMAS & MODELS
// ─────────────────────────────────────────────

// Transaction sub-schema
const transactionSchema = new mongoose.Schema({
  type:      { type: String, enum: ['deposit','withdrawal','bet','win','refund'], required: true },
  amount:    { type: Number, required: true },
  status:    { type: String, enum: ['pending','completed','failed','processing'], default: 'pending' },
  reference: { type: String },
  note:      { type: String },
  meta:      { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

// Bank details sub-schema
const bankDetailsSchema = new mongoose.Schema({
  beneficiaryName: { type: String, trim: true },
  accountNumber:   { type: String, trim: true },
  ifscCode:        { type: String, trim: true, uppercase: true },
  bankName:        { type: String, trim: true },
  verified:        { type: Boolean, default: false }
});

// User schema
const userSchema = new mongoose.Schema({
  username:      { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 20 },
  email:         { type: String, required: true, unique: true, trim: true, lowercase: true },
  password:      { type: String, required: true, minlength: 6 },
  balance:       { type: Number, default: 0, min: 0 },
  lockedBalance: { type: Number, default: 0 },
  bankDetails:   { type: bankDetailsSchema, default: () => ({}) },
  transactions:  [transactionSchema],
  isActive:      { type: Boolean, default: true },
  lastLogin:     { type: Date },
  createdAt:     { type: Date, default: Date.now }
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

userSchema.methods.addTransaction = function (type, amount, status, note, meta) {
  this.transactions.unshift({ type, amount, status, note, meta });
  if (this.transactions.length > 100) this.transactions = this.transactions.slice(0, 100);
};

const User = mongoose.model('User', userSchema);

// Bet sub-schema (for Round)
const betSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username:    String,
  betAmount:   Number,
  cashedOutAt: { type: Number, default: null },
  winAmount:   { type: Number, default: 0 }
});

// Round schema
const roundSchema = new mongoose.Schema({
  roundId:        { type: Number, required: true, unique: true },
  crashPoint:     { type: Number, required: true },
  startedAt:      { type: Date, default: Date.now },
  endedAt:        { type: Date },
  bets:           [betSchema],
  totalBetAmount: { type: Number, default: 0 },
  totalWinAmount: { type: Number, default: 0 }
});

const Round = mongoose.model('Round', roundSchema);

// ─────────────────────────────────────────────
//  GAME ENGINE
// ─────────────────────────────────────────────

function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.55) return parseFloat((1.00 + Math.random() * 0.10).toFixed(2)); // 55% crash between 1.00–1.10
  if (r < 0.80) return parseFloat((1.10 + Math.random() * 0.15).toFixed(2)); // 25% crash between 1.10–1.25
  if (r < 0.92) return parseFloat((1.25 + Math.random() * 0.75).toFixed(2)); // 12% crash between 1.25–2.00
  if (r < 0.97) return parseFloat((2.00 + Math.random() * 3.00).toFixed(2)); //  5% crash between 2.00–5.00
  return parseFloat((5.00 + Math.random() * 15).toFixed(2));                 //  3% crash between 5.00–20.00
}

function calcMultiplier(elapsedMs) {
  return parseFloat(Math.pow(Math.E, elapsedMs * 0.00008).toFixed(2));
}

class GameEngine {
  constructor(io) {
    this.io               = io;
    this.state            = 'waiting';
    this.currentRound     = null;
    this.roundId          = 1;
    this.crashPoint       = 1.5;
    this.currentMultiplier = 1.00;
    this.startTime        = null;
    this.tickInterval     = null;
    this.waitTimeout      = null;
    this.activeBets       = new Map();
    this.roundBets        = [];
  }

  async init() {
    const last = await Round.findOne().sort({ roundId: -1 });
    this.roundId = last ? last.roundId + 1 : 1;
    console.log(`[GameEngine] Starting from round #${this.roundId}`);
    this.startWaiting();
  }

  startWaiting(waitSec = 7) {
    this.state            = 'waiting';
    this.activeBets.clear();
    this.roundBets        = [];
    this.currentMultiplier = 1.00;
    this.crashPoint       = generateCrashPoint();

    this.io.emit('game:waiting', { roundId: this.roundId, waitSeconds: waitSec });
    console.log(`[Round #${this.roundId}] Waiting ${waitSec}s — crash at ${this.crashPoint}x`);
    this.waitTimeout = setTimeout(() => this.startRound(), waitSec * 1000);
  }

  startRound() {
    this.state      = 'flying';
    this.startTime  = Date.now();
    this.currentRound = { roundId: this.roundId, crashPoint: this.crashPoint, startedAt: new Date() };

    this.io.emit('game:started', { roundId: this.roundId });
    console.log(`[Round #${this.roundId}] Started! Crash at ${this.crashPoint}x`);

    this.tickInterval = setInterval(() => {
      const elapsed          = Date.now() - this.startTime;
      this.currentMultiplier = calcMultiplier(elapsed);
      this.io.emit('game:tick', { multiplier: this.currentMultiplier, elapsed });
      if (this.currentMultiplier >= this.crashPoint) this.triggerCrash();
    }, 100);
  }

  async triggerCrash() {
    clearInterval(this.tickInterval);
    this.state        = 'crashed';
    const finalMult   = this.crashPoint;

    this.io.emit('game:crashed', { roundId: this.roundId, crashPoint: finalMult });
    console.log(`[Round #${this.roundId}] CRASHED at ${finalMult}x`);

    try {
      await Round.create({
        roundId:        this.roundId,
        crashPoint:     finalMult,
        startedAt:      this.currentRound?.startedAt,
        endedAt:        new Date(),
        bets:           this.roundBets,
        totalBetAmount: this.roundBets.reduce((s, b) => s + b.betAmount, 0),
        totalWinAmount: this.roundBets.reduce((s, b) => s + b.winAmount, 0)
      });
    } catch (err) {
      console.error('[GameEngine] Failed to save round:', err.message);
    }

    this.roundId++;
    setTimeout(() => this.startWaiting(6), 3000);
  }

  placeBet(userId, username, amount, slot) {
    if (this.state !== 'waiting') return false;
    if (this.activeBets.has(`${userId}_${slot}`)) return false;
    this.activeBets.set(`${userId}_${slot}`, { betAmount: amount, username });
    this.roundBets.push({ userId, username, betAmount: amount, cashedOutAt: null, winAmount: 0 });
    this.io.emit('game:bet_placed', { username, betAmount: amount });
    return true;
  }

  cashOut(userId, slot) {
    if (this.state !== 'flying') return null;
    const key = `${userId}_${slot}`;
    const bet = this.activeBets.get(key);
    if (!bet) return null;
    this.activeBets.delete(key);
    const winAmount = parseFloat((bet.betAmount * this.currentMultiplier).toFixed(2));
    const rb = this.roundBets.find(b => String(b.userId) === String(userId) && b.cashedOutAt === null);
    if (rb) { rb.cashedOutAt = this.currentMultiplier; rb.winAmount = winAmount; }
    this.io.emit('game:cashed_out', { username: bet.username, multiplier: this.currentMultiplier, winAmount });
    return { multiplier: this.currentMultiplier, winAmount, betAmount: bet.betAmount };
  }

  getState() {
    return {
      state:      this.state,
      roundId:    this.roundId,
      multiplier: this.currentMultiplier,
      elapsed:    this.startTime ? Date.now() - this.startTime : 0
    };
  }
}

// ─────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return res.status(401).json({ error: 'No token provided' });

    const token   = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findById(decoded.id).select('-password');
    if (!user || !user.isActive)
      return res.status(401).json({ error: 'Invalid token or user deactivated' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token expired' });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ─────────────────────────────────────────────
//  EXPRESS APP & SERVER
// ─────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://drippygamesv2.netlify.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
};

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true }
});

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('../frontend'));

const limiter     = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// ─────────────────────────────────────────────
//  AUTH ROUTES   /api/auth
// ─────────────────────────────────────────────

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

const authRouter = express.Router();

// POST /api/auth/register
authRouter.post('/register', [
  body('username').trim().isLength({ min: 3, max: 20 }).withMessage('Username must be 3-20 chars'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 chars')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { username, email, password } = req.body;
    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists) {
      const field = exists.email === email ? 'Email' : 'Username';
      return res.status(409).json({ error: `${field} already in use` });
    }
    const user = await User.create({ username, email, password, balance: 100 });
    user.addTransaction('deposit', 100, 'completed', 'Welcome bonus 🎉');
    await user.save();
    const token = signToken(user._id);
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
authRouter.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.isActive) return res.status(403).json({ error: 'Account deactivated' });

    user.lastLogin = new Date();
    await user.save();
    const token = signToken(user._id);
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
authRouter.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.user._id).select('-password');
  res.json({ user: user.toSafeObject() });
});

// PUT /api/auth/bank
authRouter.put('/bank', auth, [
  body('beneficiaryName').trim().notEmpty().withMessage('Beneficiary name required'),
  body('accountNumber').trim().isLength({ min: 9, max: 18 }).withMessage('Valid account number required'),
  body('ifscCode').trim().matches(/^[A-Z]{4}0[A-Z0-9]{6}$/).withMessage('Valid IFSC required (e.g. SBIN0001234)'),
  body('bankName').trim().notEmpty().withMessage('Bank name required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { beneficiaryName, accountNumber, ifscCode, bankName } = req.body;
    const user = await User.findById(req.user._id);
    user.bankDetails = { beneficiaryName, accountNumber, ifscCode, bankName, verified: false };
    await user.save();
    res.json({ message: 'Bank details saved', bankDetails: user.bankDetails });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.use('/api/auth', authRouter);

// ─────────────────────────────────────────────
//  WALLET ROUTES   /api/wallet
// ─────────────────────────────────────────────

const walletRouter = express.Router();

// GET /api/wallet/balance
walletRouter.get('/balance', auth, async (req, res) => {
  const user = await User.findById(req.user._id).select('balance lockedBalance');
  res.json({ balance: user.balance, lockedBalance: user.lockedBalance });
});

// GET /api/wallet/transactions
walletRouter.get('/transactions', auth, async (req, res) => {
  const user = await User.findById(req.user._id).select('transactions');
  res.json({ transactions: user.transactions });
});

// POST /api/wallet/deposit
walletRouter.post('/deposit', auth, [
  body('amount').isFloat({ min: 100, max: 100000 }).withMessage('Deposit must be ₹100 - ₹1,00,000'),
  body('utr').optional().trim(),
  body('method').optional().isIn(['upi','card','netbanking'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { amount, method = 'upi', utr } = req.body;
    if (!utr || utr.trim().length < 8)
      return res.status(400).json({ error: 'Valid UTR number is required' });

    const user = await User.findById(req.user._id);
    const reference = 'DEP' + Date.now();

    // Balance NOT credited yet — pending admin UTR verification
    user.addTransaction('deposit', parseFloat(amount), 'pending',
      `UPI deposit pending UTR verification (UTR: ${utr})`, { reference, method, utr });
    await user.save();

    console.log(`[Deposit] ${user.username} submitted ₹${amount} | UTR: ${utr}`);
    res.json({ success: true, reference, newBalance: user.balance,
      message: `₹${amount} deposit submitted! We\'ll verify UTR ${utr} and credit within 30 mins.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/wallet/withdraw
walletRouter.post('/withdraw', auth, [
  body('amount').isFloat({ min: 1100, max: 100000 }).withMessage('Withdrawal must be ₹1,100 - ₹1,00,000'),
  body('method').optional().isIn(['upi','bank']),
  body('upiId').optional().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { amount, method = 'bank', upiId } = req.body;
    const user = await User.findById(req.user._id);

    if (user.balance < parseFloat(amount))
      return res.status(400).json({ error: 'Insufficient balance' });

    if (method === 'upi') {
      if (!upiId || !upiId.includes('@'))
        return res.status(400).json({ error: 'Valid UPI ID required (e.g. name@upi)' });

      const reference = 'WD' + Date.now();
      user.balance -= parseFloat(amount);
      user.addTransaction('withdrawal', parseFloat(amount), 'processing',
        `UPI withdrawal to ${upiId}`, { reference, method: 'upi', upiId });
      await user.save();
      console.log(`[Withdraw] ${user.username} ₹${amount} -> UPI: ${upiId}`);
      res.json({ success: true, reference, newBalance: user.balance,
        message: `₹${amount} withdrawal to ${upiId} initiated. Processing in 1-24 hrs.` });
    } else {
      if (!user.bankDetails?.accountNumber)
        return res.status(400).json({ error: 'Please add bank details before withdrawing' });

      const reference = 'WD' + Date.now();
      user.balance -= parseFloat(amount);
      user.addTransaction('withdrawal', parseFloat(amount), 'processing',
        `Bank withdrawal to ${user.bankDetails.bankName} ****${user.bankDetails.accountNumber.slice(-4)}`,
        { reference, method: 'bank', bankDetails: { ...user.bankDetails.toObject() } });
      await user.save();
      console.log(`[Withdraw] ${user.username} ₹${amount} -> Bank: ****${user.bankDetails.accountNumber.slice(-4)}`);
      res.json({ success: true, reference, newBalance: user.balance,
        message: `₹${amount} withdrawal initiated. Processing in 1-3 business days.` });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.use('/api/wallet', walletRouter);

// ─────────────────────────────────────────────
//  GAME ROUTES   /api/game
// ─────────────────────────────────────────────

const gameRouter = express.Router();

// GET /api/game/history
gameRouter.get('/history', async (req, res) => {
  try {
    const rounds = await Round.find({ endedAt: { $exists: true } })
      .sort({ roundId: -1 }).limit(20).select('roundId crashPoint endedAt');
    res.json({ rounds });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/game/round/:id
gameRouter.get('/round/:id', async (req, res) => {
  try {
    const round = await Round.findOne({ roundId: req.params.id });
    if (!round) return res.status(404).json({ error: 'Round not found' });
    res.json({ round });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/game/bet
gameRouter.post('/bet', auth, [
  body('amount').isFloat({ min: 10, max: 50000 }),
  body('roundId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { amount, roundId } = req.body;
    const user = await User.findById(req.user._id);
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    user.balance      -= parseFloat(amount);
    user.lockedBalance += parseFloat(amount);
    user.addTransaction('bet', parseFloat(amount), 'completed', `Bet on round #${roundId}`, { roundId });
    await user.save();
    res.json({ success: true, newBalance: user.balance });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/game/cashout
gameRouter.post('/cashout', auth, [
  body('roundId').isInt(),
  body('multiplier').isFloat({ min: 1 }),
  body('betAmount').isFloat({ min: 10 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { roundId, multiplier, betAmount } = req.body;
    const winAmount = parseFloat(betAmount) * parseFloat(multiplier);
    const user = await User.findById(req.user._id);

    user.balance      += winAmount;
    user.lockedBalance = Math.max(0, user.lockedBalance - parseFloat(betAmount));
    user.addTransaction('win', winAmount, 'completed',
      `Cashed out at ${multiplier}x on round #${roundId}`,
      { roundId, multiplier, betAmount });
    await user.save();
    res.json({ success: true, winAmount, newBalance: user.balance });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.use('/api/game', gameRouter);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ─────────────────────────────────────────────
//  SOCKET.IO
// ─────────────────────────────────────────────

const engine = new GameEngine(io);

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user    = await User.findById(decoded.id).select('-password');
      socket.user   = user;
    } catch (e) { /* invalid token — allow as guest */ }
  }
  next();
});

io.on('connection', (socket) => {
  const username = socket.user?.username || 'Guest';
  console.log(`[Socket] ${username} connected (${socket.id})`);

  socket.emit('game:state', engine.getState());

  // Place bet
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

      user.balance       -= parseFloat(amount);
      user.lockedBalance += parseFloat(amount);
      user.addTransaction('bet', parseFloat(amount), 'completed',
        `Bet on round #${engine.roundId}`, { roundId: engine.roundId });
      await user.save();

      socket.emit('game:bet_confirmed', { slot, amount, newBalance: user.balance, roundId: engine.roundId });
    } catch (err) {
      console.error(err);
      socket.emit('error', { message: 'Server error placing bet' });
    }
  });

  // Cash out
  socket.on('game:cashout', async ({ slot }) => {
    if (!socket.user) return socket.emit('error', { message: 'Not authenticated' });
    if (engine.state !== 'flying') return socket.emit('error', { message: 'No active round' });

    try {
      const result = engine.cashOut(socket.user._id, slot || 1);
      if (!result) return socket.emit('error', { message: 'No active bet to cash out' });

      const user = await User.findById(socket.user._id);
      user.balance      += result.winAmount;
      user.lockedBalance = Math.max(0, user.lockedBalance - result.betAmount);
      user.addTransaction('win', result.winAmount, 'completed',
        `Cashed out at ${result.multiplier}x on round #${engine.roundId}`,
        { roundId: engine.roundId, multiplier: result.multiplier });
      await user.save();

      socket.emit('game:cashout_confirmed', {
        multiplier: result.multiplier,
        winAmount:  result.winAmount,
        newBalance: user.balance
      });
    } catch (err) {
      console.error(err);
      socket.emit('error', { message: 'Server error cashing out' });
    }
  });

  socket.on('disconnect', () => console.log(`[Socket] ${username} disconnected`));
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────

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
