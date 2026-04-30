const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['deposit', 'withdrawal', 'bet', 'win', 'refund'], required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'completed', 'failed', 'processing'], default: 'pending' },
  reference: { type: String },
  note: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

const bankDetailsSchema = new mongoose.Schema({
  beneficiaryName: { type: String, trim: true },
  accountNumber: { type: String, trim: true },
  ifscCode: { type: String, trim: true, uppercase: true },
  bankName: { type: String, trim: true },
  verified: { type: Boolean, default: false }
});

const userSchema = new mongoose.Schema({
  username: {
    type: String, required: true, unique: true,
    trim: true, minlength: 3, maxlength: 20
  },
  email: {
    type: String, required: true, unique: true,
    trim: true, lowercase: true
  },
  password: { type: String, required: true, minlength: 6 },
  balance: { type: Number, default: 0, min: 0 },
  lockedBalance: { type: Number, default: 0 }, // balance locked in active bets
  bankDetails: { type: bankDetailsSchema, default: () => ({}) },
  transactions: [transactionSchema],
  isActive: { type: Boolean, default: true },
  lastLogin: { type: Date },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// Safe user object (no password)
userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

// Add transaction helper
userSchema.methods.addTransaction = function (type, amount, status, note, meta) {
  this.transactions.unshift({ type, amount, status, note, meta });
  if (this.transactions.length > 100) this.transactions = this.transactions.slice(0, 100);
};

module.exports = mongoose.model('User', userSchema);
