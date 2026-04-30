const mongoose = require('mongoose');

const betSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username: String,
  betAmount: Number,
  cashedOutAt: { type: Number, default: null }, // null = crashed
  winAmount: { type: Number, default: 0 }
});

const roundSchema = new mongoose.Schema({
  roundId: { type: Number, required: true, unique: true },
  crashPoint: { type: Number, required: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  bets: [betSchema],
  totalBetAmount: { type: Number, default: 0 },
  totalWinAmount: { type: Number, default: 0 }
});

module.exports = mongoose.model('Round', roundSchema);
