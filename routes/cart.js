const express = require('express');
const Cart = require('../models/Cart');
const { protect } = require('../middleware/auth'); // Cookie-based auth

const router = express.Router();

// GET /api/cart - Fetch current user's cart
router.get('/', protect, async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id }).populate('items.productId');
    res.json(cart || { items: [] }); // fallback to empty cart
  } catch (err) {
    console.error('[GET /api/cart] ❌', err.message);
    res.status(500).json({ message: 'Failed to load cart' });
  }
});

// POST /api/cart - Add/update an item in cart
router.post('/', protect, async (req, res) => {
  const { productId, quantity } = req.body;

  if (!productId || typeof quantity !== 'number' || quantity < 1) {
    return res.status(400).json({ message: 'Invalid productId or quantity' });
  }

  try {
    let cart = await Cart.findOne({ user: req.user._id });

    // Create cart if none exists
    if (!cart) {
      cart = new Cart({ user: req.user._id, items: [] });
    }

    const index = cart.items.findIndex(
      (item) => item.productId.toString() === productId.toString()
    );

    if (index > -1) {
      cart.items[index].quantity = quantity;
    } else {
      cart.items.push({ productId, quantity });
    }

    await cart.save();

    const updatedCart = await Cart.findOne({ user: req.user._id }).populate('items.productId');
    res.json(updatedCart);
  } catch (err) {
    console.error('[POST /api/cart] ❌', err.message);
    res.status(500).json({ message: 'Failed to update cart' });
  }
});

// DELETE /api/cart/:productId - Remove item from cart
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
    console.error('[DELETE /api/cart/:productId] ❌', err.message);
    res.status(500).json({ message: 'Failed to remove item from cart' });
  }
});

module.exports = router;
