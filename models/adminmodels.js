const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const adminSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      minlength: 3,
    },
    email: {
      type: String,
      required: [true, 'Admin email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
    },
    role: {
      type: String,
      default: 'admin',
    },
  },
  {
    timestamps: true,
    toJSON: {
      // Hide password when sending admin object via res.json()
      transform(doc, ret) {
        delete ret.password;
        return ret;
      },
    },
  }
);

// 🔐 Hash password before saving
adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ✅ Compare entered password with stored hash
adminSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

const Admin = mongoose.model('Admin', adminSchema);
module.exports = Admin;
