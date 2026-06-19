// =============================================
// FRONTEND COMPATIBILITY ROUTES
// =============================================

// Create shop (for frontend)
app.post('/api/create-shop', async (req, res) => {
  const { fullName, shopName, phone, password } = req.body;
  
  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (name, shop_name, phone, password) VALUES (?, ?, ?, ?)`,
      [fullName, shopName, phone, hashed],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ success: false, error: 'Shop name already exists' });
          }
          console.error('Signup error:', err);
          return res.status(500).json({ success: false, error: err.message });
        }
        const token = jwt.sign({ userId: this.lastID }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ 
          success: true, 
          message: 'Shop created!',
          token,
          user: { id: this.lastID, name: fullName, shop_name: shopName, phone }
        });
      }
    );
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Login (for frontend)
app.post('/api/login', (req, res) => {
  const { phone, password } = req.body;
  
  db.get(`SELECT * FROM users WHERE phone = ?`, [phone], async (err, user) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Wrong password' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        shop_name: user.shop_name,
        phone: user.phone
      }
    });
  });
});

// Test route
app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is working!' });
});