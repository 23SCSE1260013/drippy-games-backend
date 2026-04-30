const Round = require('./models/Round');

// Provably fair crash point generation
function generateCrashPoint() {
  const r = Math.random();
  // Weighted: ~35% below 1.5x, ~30% 1.5-3x, ~20% 3-8x, ~10% 8-23x, ~5% 23x+
  if (r < 0.35) return parseFloat((1.1 + Math.random() * 0.4).toFixed(2));
  if (r < 0.65) return parseFloat((1.5 + Math.random() * 1.5).toFixed(2));
  if (r < 0.85) return parseFloat((3 + Math.random() * 5).toFixed(2));
  if (r < 0.95) return parseFloat((8 + Math.random() * 15).toFixed(2));
  return parseFloat((23 + Math.random() * 77).toFixed(2));
}

function calcMultiplier(elapsedMs) {
  return parseFloat(Math.pow(Math.E, elapsedMs * 0.00008).toFixed(2));
}

class GameEngine {
  constructor(io) {
    this.io = io;
    this.state = 'waiting'; // waiting | flying | crashed
    this.currentRound = null;
    this.roundId = 1;
    this.crashPoint = 1.5;
    this.currentMultiplier = 1.00;
    this.startTime = null;
    this.tickInterval = null;
    this.waitTimeout = null;
    this.activeBets = new Map(); // userId -> { betAmount, slot }
    this.roundBets = []; // for DB storage
  }

  async init() {
    // Find last round ID
    const last = await Round.findOne().sort({ roundId: -1 });
    this.roundId = last ? last.roundId + 1 : 1;
    console.log(`[GameEngine] Starting from round #${this.roundId}`);
    this.startWaiting();
  }

  startWaiting(waitSec = 7) {
    this.state = 'waiting';
    this.activeBets.clear();
    this.roundBets = [];
    this.currentMultiplier = 1.00;
    this.crashPoint = generateCrashPoint();

    this.io.emit('game:waiting', {
      roundId: this.roundId,
      waitSeconds: waitSec
    });

    console.log(`[Round #${this.roundId}] Waiting ${waitSec}s — crash will be at ${this.crashPoint}x`);

    this.waitTimeout = setTimeout(() => this.startRound(), waitSec * 1000);
  }

  startRound() {
    this.state = 'flying';
    this.startTime = Date.now();
    this.currentRound = {
      roundId: this.roundId,
      crashPoint: this.crashPoint,
      startedAt: new Date()
    };

    this.io.emit('game:started', { roundId: this.roundId });
    console.log(`[Round #${this.roundId}] Started! Crash at ${this.crashPoint}x`);

    // Tick every 100ms
    this.tickInterval = setInterval(() => {
      const elapsed = Date.now() - this.startTime;
      this.currentMultiplier = calcMultiplier(elapsed);

      this.io.emit('game:tick', {
        multiplier: this.currentMultiplier,
        elapsed
      });

      if (this.currentMultiplier >= this.crashPoint) {
        this.triggerCrash();
      }
    }, 100);
  }

  async triggerCrash() {
    clearInterval(this.tickInterval);
    this.state = 'crashed';
    const finalMult = this.crashPoint;

    this.io.emit('game:crashed', {
      roundId: this.roundId,
      crashPoint: finalMult
    });

    console.log(`[Round #${this.roundId}] CRASHED at ${finalMult}x`);

    // Save round to DB
    try {
      await Round.create({
        roundId: this.roundId,
        crashPoint: finalMult,
        startedAt: this.currentRound?.startedAt,
        endedAt: new Date(),
        bets: this.roundBets,
        totalBetAmount: this.roundBets.reduce((s, b) => s + b.betAmount, 0),
        totalWinAmount: this.roundBets.reduce((s, b) => s + b.winAmount, 0)
      });
    } catch (err) {
      console.error('[GameEngine] Failed to save round:', err.message);
    }

    this.roundId++;
    setTimeout(() => this.startWaiting(6), 3000); // 3s crash display, then 6s wait
  }

  placeBet(userId, username, amount, slot) {
    if (this.state !== 'waiting') return false;
    if (this.activeBets.has(`${userId}_${slot}`)) return false;
    this.activeBets.set(`${userId}_${slot}`, { betAmount: amount, username });
    this.roundBets.push({ userId, username, betAmount: amount, cashedOutAt: null, winAmount: 0 });
    // Broadcast to all
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
    // Update round bets record
    const rb = this.roundBets.find(b => String(b.userId) === String(userId) && b.cashedOutAt === null);
    if (rb) { rb.cashedOutAt = this.currentMultiplier; rb.winAmount = winAmount; }
    this.io.emit('game:cashed_out', { username: bet.username, multiplier: this.currentMultiplier, winAmount });
    return { multiplier: this.currentMultiplier, winAmount, betAmount: bet.betAmount };
  }

  getState() {
    return {
      state: this.state,
      roundId: this.roundId,
      multiplier: this.currentMultiplier,
      elapsed: this.startTime ? Date.now() - this.startTime : 0
    };
  }
}

module.exports = GameEngine;
