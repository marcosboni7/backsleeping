const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  room: { type: String, required: true }, // Nome da sala (ex: 'Portal Zen')
  user: { type: String, required: true },
  text: { type: String, required: true },
  auraColor: { type: String },
  auraName: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Message', MessageSchema);