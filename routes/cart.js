const express = require('express');
const Cart = require('../models/Cart');
const { protect } = require('../middleware/auth'); // Uses your cookie-based auth

const router = express.Router();

// ✅ GET /api/cart - Get current user's cart
router.get('/', protect, async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id }).populate('items.productId');
    res.json(cart || { items: [] });
  } catch (err) {
    console.error('[Cart GET] Error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ POST /api/cart - Add or update a cart item
router.post('/', protect, async (req, res) => {
  const { productId, quantity } = req.body;

  // 🔒 Validate input
  if (!productId) {
    return res.status(400).json({ message: 'Missing productId' });
  }

  try {
    let cart = await Cart.findOne({ user: req.user._id });

    // 🛒 Create cart if it doesn't exist
    if (!cart) {
      cart = new Cart({ user: req.user._id, items: [] });
    }

    // 🔁 Update quantity if product already exists
    const index = cart.items.findIndex(
      (item) => item.productId.toString() === productId.toString()
    );

    if (index > -1) {
      cart.items[index].quantity = quantity;
    } else {
      // ➕ Add new item
      cart.items.push({ productId, quantity });
    }

    await cart.save();

    // ✅ Return fully populated cart
    const updatedCart = await Cart.findOne({ user: req.user._id }).populate('items.productId');
    res.json(updatedCart);
  } catch (err) {
    console.error('[Cart POST] Error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ DELETE /api/cart/:productId - Remove item from cart
router.delete('/:productId', protect, async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      return res.status(404).json({ message: 'Cart not found' });
    }

    cart.items = cart.items.filter(
      (item) => item.productId.toString() !== req.params.productId.toString()
    );

    await cart.save();

    const updatedCart = await Cart.findOne({ user: req.user._id }).populate('items.productId');
    res.json(updatedCart);
  } catch (err) {
    console.error('[Cart DELETE] Error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
