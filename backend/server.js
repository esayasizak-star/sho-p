require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'sho-p-secret-key-2026';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create uploads folder if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Serve uploaded files
app.use('/uploads', express.static(uploadDir));

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + '-' + file.originalname);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// =============================================
// Helper: Verify JWT
// =============================================
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// =============================================
// 1. AUTH Routes
// =============================================

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { name, shop_name, phone, password } = req.body;

  if (!name || !shop_name || !password) {
    return res.status(400).json({ error: 'Name, shop name, and password required' });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (name, shop_name, phone, password) VALUES (?, ?, ?, ?)`,
      [name, shop_name, phone, hashed],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Shop name already exists' });
          }
          console.error('Signup error:', err);
          return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, userId: this.lastID, message: 'Shop created!' });
      }
    );
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { shop_name, password } = req.body;

  if (!shop_name || !password) {
    return res.status(400).json({ error: 'Shop name and password required' });
  }

  db.get(`SELECT * FROM users WHERE shop_name = ?`, [shop_name], async (err, user) => {
    if (err) {
      console.error('Login error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (!user) {
      return res.status(401).json({ error: 'Shop not found' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        shop_name: user.shop_name,
        phone: user.phone,
        avatar: user.avatar,
        followers: user.followers,
        balance: user.balance
      }
    });
  });
});

// Get current user
app.get('/api/auth/me', verifyToken, (req, res) => {
  db.get(`SELECT id, name, shop_name, phone, avatar, followers, balance FROM users WHERE id = ?`,
    [req.userId], (err, user) => {
      if (err) {
        console.error('Get user error:', err);
        return res.status(500).json({ error: err.message });
      }
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json(user);
    }
  );
});

// =============================================
// 2. PRODUCT Routes
// =============================================

// Get all products (with seller info and follow status)
app.get('/api/products', verifyToken, (req, res) => {
  const query = `
    SELECT p.*, u.shop_name as seller_shop, u.id as seller_id,
      (SELECT COUNT(*) FROM follows WHERE seller_id = u.id AND follower_id = ?) as is_followed
    FROM products p
    JOIN users u ON p.seller_id = u.id
    WHERE p.sold = 0
    ORDER BY 
      CASE WHEN (SELECT COUNT(*) FROM follows WHERE seller_id = u.id AND follower_id = ?) > 0 THEN 1 ELSE 2 END,
      p.id DESC
  `;
  db.all(query, [req.userId, req.userId], (err, products) => {
    if (err) {
      console.error('Get products error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(products);
  });
});

// Get single product
app.get('/api/products/:id', verifyToken, (req, res) => {
  db.get(`
    SELECT p.*, u.shop_name as seller_shop, u.id as seller_id,
      (SELECT COUNT(*) FROM follows WHERE seller_id = u.id AND follower_id = ?) as is_followed
    FROM products p
    JOIN users u ON p.seller_id = u.id
    WHERE p.id = ?
  `, [req.userId, req.params.id], (err, product) => {
    if (err) {
      console.error('Get product error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  });
});

// Create product (with 5 ETB fee)
app.post('/api/products', verifyToken, upload.single('photo'), async (req, res) => {
  const { name, category, price, quantity, description } = req.body;
  const photo = req.file ? `/uploads/${req.file.filename}` : null;
  const LISTING_FEE = 5;

  console.log('Creating product:', { name, category, price, quantity, description, photo });

  if (!name || !category || !price) {
    return res.status(400).json({ error: 'Name, category, and price are required' });
  }

  db.get(`SELECT balance FROM users WHERE id = ?`, [req.userId], (err, user) => {
    if (err) {
      console.error('Balance error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.balance < LISTING_FEE) {
      return res.status(400).json({ error: 'Insufficient balance. Add funds to list products.' });
    }

    db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [LISTING_FEE, req.userId], function(err) {
      if (err) {
        console.error('Update balance error:', err);
        return res.status(500).json({ error: err.message });
      }

      db.run(`
        INSERT INTO products (seller_id, name, category, price, quantity, description, photo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [req.userId, name, category, price, quantity || 0, description, photo], function(err) {
        if (err) {
          console.error('Insert product error:', err);
          return res.status(500).json({ error: err.message });
        }
        res.json({ 
          success: true, 
          productId: this.lastID, 
          message: 'Product listed! 5 ETB fee deducted.' 
        });
      });
    });
  });
});

// Get seller's products
app.get('/api/seller/products', verifyToken, (req, res) => {
  db.all(`SELECT * FROM products WHERE seller_id = ? ORDER BY id DESC`, [req.userId], (err, products) => {
    if (err) {
      console.error('Get seller products error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(products);
  });
});

// Update product
app.put('/api/products/:id', verifyToken, (req, res) => {
  const { name, category, price, quantity, description, sold } = req.body;
  db.run(`
    UPDATE products SET name = ?, category = ?, price = ?, quantity = ?, description = ?, sold = ?
    WHERE id = ? AND seller_id = ?
  `, [name, category, price, quantity || 0, description, sold || 0, req.params.id, req.userId], function(err) {
    if (err) {
      console.error('Update product error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Product not found or not yours' });
    }
    res.json({ success: true, message: 'Product updated' });
  });
});

// Toggle sold status
app.patch('/api/products/:id/toggle-sold', verifyToken, (req, res) => {
  db.run(`
    UPDATE products SET sold = NOT sold WHERE id = ? AND seller_id = ?
  `, [req.params.id, req.userId], function(err) {
    if (err) {
      console.error('Toggle sold error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Product not found or not yours' });
    }
    res.json({ success: true, message: 'Status toggled' });
  });
});

// Delete product
app.delete('/api/products/:id', verifyToken, (req, res) => {
  db.run(`DELETE FROM products WHERE id = ? AND seller_id = ?`, [req.params.id, req.userId], function(err) {
    if (err) {
      console.error('Delete product error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Product not found or not yours' });
    }
    res.json({ success: true, message: 'Product deleted' });
  });
});

// =============================================
// 3. CART Routes
// =============================================

app.get('/api/cart', verifyToken, (req, res) => {
  db.all(`
    SELECT c.*, p.name, p.price, p.category, p.photo
    FROM cart c
    JOIN products p ON c.product_id = p.id
    WHERE c.user_id = ?
  `, [req.userId], (err, items) => {
    if (err) {
      console.error('Get cart error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(items);
  });
});

app.post('/api/cart', verifyToken, (req, res) => {
  const { productId, quantity = 1 } = req.body;
  db.run(`
    INSERT INTO cart (user_id, product_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, product_id) DO UPDATE SET quantity = quantity + ?
  `, [req.userId, productId, quantity, quantity], function(err) {
    if (err) {
      console.error('Add to cart error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, message: 'Added to cart' });
  });
});

app.put('/api/cart/:productId', verifyToken, (req, res) => {
  const { quantity } = req.body;
  db.run(`
    UPDATE cart SET quantity = ? WHERE user_id = ? AND product_id = ?
  `, [quantity, req.userId, req.params.productId], function(err) {
    if (err) {
      console.error('Update cart error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true });
  });
});

app.delete('/api/cart/:productId', verifyToken, (req, res) => {
  db.run(`DELETE FROM cart WHERE user_id = ? AND product_id = ?`, [req.userId, req.params.productId], function(err) {
    if (err) {
      console.error('Remove from cart error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true });
  });
});

// =============================================
// 4. ORDER Routes
// =============================================

app.post('/api/orders', verifyToken, (req, res) => {
  const { items, total } = req.body;

  db.run(`INSERT INTO orders (user_id, total) VALUES (?, ?)`, [req.userId, total], function(err) {
    if (err) {
      console.error('Create order error:', err);
      return res.status(500).json({ error: err.message });
    }
    const orderId = this.lastID;

    db.run(`DELETE FROM cart WHERE user_id = ?`, [req.userId]);

    res.json({ success: true, orderId, message: 'Order placed!' });
  });
});

app.get('/api/orders', verifyToken, (req, res) => {
  db.all(`SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC`, [req.userId], (err, orders) => {
    if (err) {
      console.error('Get orders error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(orders);
  });
});

// =============================================
// 5. PAYMENT METHODS Routes
// =============================================

app.get('/api/payment-methods', verifyToken, (req, res) => {
  db.all(`SELECT * FROM payment_methods WHERE user_id = ?`, [req.userId], (err, methods) => {
    if (err) {
      console.error('Get payment methods error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(methods);
  });
});

app.post('/api/payment-methods', verifyToken, (req, res) => {
  const { name, detail } = req.body;
  db.run(`
    INSERT INTO payment_methods (user_id, name, detail) VALUES (?, ?, ?)
  `, [req.userId, name, detail], function(err) {
    if (err) {
      console.error('Add payment method error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, id: this.lastID });
  });
});

app.delete('/api/payment-methods/:id', verifyToken, (req, res) => {
  db.run(`DELETE FROM payment_methods WHERE id = ? AND user_id = ?`, [req.params.id, req.userId], function(err) {
    if (err) {
      console.error('Delete payment method error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true });
  });
});

// =============================================
// 6. FOLLOW Routes
// =============================================

app.post('/api/follow/:sellerId', verifyToken, (req, res) => {
  db.run(`
    INSERT OR IGNORE INTO follows (follower_id, seller_id) VALUES (?, ?)
  `, [req.userId, req.params.sellerId], function(err) {
    if (err) {
      console.error('Follow error:', err);
      return res.status(500).json({ error: err.message });
    }
    db.run(`UPDATE users SET followers = followers + 1 WHERE id = ?`, [req.params.sellerId]);
    res.json({ success: true, following: true });
  });
});

app.delete('/api/follow/:sellerId', verifyToken, (req, res) => {
  db.run(`DELETE FROM follows WHERE follower_id = ? AND seller_id = ?`, [req.userId, req.params.sellerId], function(err) {
    if (err) {
      console.error('Unfollow error:', err);
      return res.status(500).json({ error: err.message });
    }
    db.run(`UPDATE users SET followers = followers - 1 WHERE id = ?`, [req.params.sellerId]);
    res.json({ success: true, following: false });
  });
});

// =============================================
// 7. BALANCE Routes
// =============================================

app.get('/api/balance', verifyToken, (req, res) => {
  db.get(`SELECT balance FROM users WHERE id = ?`, [req.userId], (err, user) => {
    if (err) {
      console.error('Get balance error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ balance: user?.balance || 0 });
  });
});

// Deposit - with method and reference
app.post('/api/balance/deposit', verifyToken, (req, res) => {
  const { amount, method, reference } = req.body;
  
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  console.log(`💰 Deposit: ${amount} ETB via ${method} (${reference}) for user ${req.userId}`);

  db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [amount, req.userId], function(err) {
    if (err) {
      console.error('Deposit error:', err);
      return res.status(500).json({ error: err.message });
    }
    
    db.get(`SELECT balance FROM users WHERE id = ?`, [req.userId], (err, user) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ 
        success: true, 
        message: `${amount} ETB added to balance`,
        balance: user?.balance || 0
      });
    });
  });
});

// =============================================
// 7.5 SEND MONEY TO FRIEND
// =============================================

app.post('/api/balance/send', verifyToken, async (req, res) => {
  const { targetUserId, amount, password } = req.body;

  if (!targetUserId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Valid target user ID and amount required' });
  }

  if (!password) {
    return res.status(400).json({ error: 'Password required to confirm transfer' });
  }

  // Get sender info
  db.get(`SELECT * FROM users WHERE id = ?`, [req.userId], async (err, sender) => {
    if (err) {
      console.error('Get sender error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (!sender) {
      return res.status(404).json({ error: 'Sender not found' });
    }

    // Verify password
    const valid = await bcrypt.compare(password, sender.password);
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    // Check balance
    if (sender.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Check if target user exists
    db.get(`SELECT id, shop_name FROM users WHERE id = ?`, [targetUserId], (err, target) => {
      if (err) {
        console.error('Get target error:', err);
        return res.status(500).json({ error: err.message });
      }
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (target.id === req.userId) {
        return res.status(400).json({ error: 'Cannot send money to yourself' });
      }

      // Deduct from sender
      db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [amount, req.userId], function(err) {
        if (err) {
          console.error('Deduct error:', err);
          return res.status(500).json({ error: err.message });
        }

        // Add to target
        db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [amount, targetUserId], function(err) {
          if (err) {
            console.error('Add to target error:', err);
            // Rollback: add back to sender
            db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [amount, req.userId]);
            return res.status(500).json({ error: err.message });
          }

          // Log transaction
          console.log(`💰 Transfer: ${amount} ETB from User ${req.userId} to User ${targetUserId}`);

          // Get updated balances
          db.get(`SELECT balance FROM users WHERE id = ?`, [req.userId], (err, senderData) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({
              success: true,
              message: `${amount} ETB sent to ${target.shop_name} (User #${targetUserId})`,
              newBalance: senderData?.balance || 0
            });
          });
        });
      });
    });
  });
});

// =============================================
// 8. SERVER START
// =============================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📦 API ready for Sho P frontend`);
  console.log(`📁 Uploads folder: ${uploadDir}`);
});