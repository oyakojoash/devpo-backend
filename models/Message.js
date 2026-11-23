const mongoose = require('mongoose');

const MAX_MESSAGE_LENGTH = 2000;
const messageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref() {
      if (this.senderType === 'customer') return 'User';
      if (this.senderType === 'affiliate') return 'Affiliate';
      return 'Merchant';
    },
  },
  senderType: { type: String, enum: ['customer', 'merchant', 'affiliate'], required: true },
  // Partial uniqueness keeps legacy messages without this field indexable during rollout.
  clientMessageId: { type: String, required: true, trim: true, minlength: 8, maxlength: 128, match: /^[A-Za-z0-9_-]+$/ },
  text: { type: String, required: true, trim: true, minlength: 1, maxlength: MAX_MESSAGE_LENGTH },
  readAt: { type: Date, default: null },
}, { timestamps: true, autoIndex: false, autoCreate: false });

messageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 }, { name: 'conversation_message_history' });
messageSchema.index({ conversationId: 1, senderType: 1, readAt: 1 }, { name: 'conversation_unread_messages' });
messageSchema.index(
  { conversationId: 1, senderType: 1, senderId: 1, clientMessageId: 1 },
  { unique: true, name: 'uniq_sender_client_message', partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);

messageSchema.statics.MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH;
module.exports = mongoose.models.Message || mongoose.model('Message', messageSchema);
