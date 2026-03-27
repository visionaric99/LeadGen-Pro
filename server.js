const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const https = require('https');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3737;
const JWT_SECRET = process.env.JWT_SECRET || 'leadgen-secret-change-in-production';
const RAPID_KEY = process.env.RAPID_KEY || '329f1147c9msh86f85560447ea6ap15a93djsnf892c1bfece5';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── USERS (in-memory — replace with a DB like PlanetScale or Supabase later)
const users = new Map();
users.set('visionaricscaling@gmail.com', {
  email: 'visionaricscaling@gmail.com',
  password: bcrypt.hashSync('Visionaric2024!', 10),
  plan: 'agency',
  stripeCustomerId: null,
  createdAt: new Date().toISOString()
});

// ── PLANS ──────────────────────────────────────────────────────────────────
const PLANS = {
  free:   { exports: 0,      searchLimit: 100, dailySearches: 3,         label: 'Free',   price: 0   },
  basic:  { exports: 50,     searchLimit: 100, dailySearches: 50,        label: 'Basic',  price: 29  },
  pro:    { exports: 200,    searchLimit: 100, dailySearches: 200,       label: 'Pro',    price: 79  },
  agency: { exports: 999999, searchLimit: 100, dailySearches: 999999,    label: 'Agency', price: 199 }
};

// ── CACHE (24hr) ───────────────────────────────────────────────────────────
const searchCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms

function getCached(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { searchCache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  searchCache.set(key, { data, ts: Date.now() });
  // Keep cache from growing too large — max 500 entries
  if (searchCache.size > 500) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
}

// ── RATE LIMITER (per user, per minute) ────────────────────────────────────
const rateLimits = new Map();
function checkRateLimit(email, maxPerMinute = 10) {
  const now = Date.now();
  const window = 60 * 1000;
  const key = email;
  if (!rateLimits.has(key)) rateLimits.set(key, []);
  const calls = rateLimits.get(key).filter(t => now - t < window);
  if (calls.length >= maxPerMinute) return false;
  calls.push(now);
  rateLimits.set(key, calls);
  return true;
}

// ── DAILY SEARCH COUNTER ───────────────────────────────────────────────────
const dailyCounts = new Map();
function checkDailyLimit(email, limit) {
  if (limit >= 999999) return true; // agency = unlimited
  const today = new Date().toISOString().slice(0, 10);
  const key = email + ':' + today;
  const count = dailyCounts.get(key) || 0;
  if (count >= limit) return false;
  dailyCounts.set(key, count + 1);
  return true;
}

const STRIPE_PRICES = {
  basic:  process.env.STRIPE_PRICE_BASIC  || '',
  pro:    process.env.STRIPE_PRICE_PRO    || '',
  agency: process.env.STRIPE_PRICE_AGENCY || ''
};

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired — please log in again' }); }
}

// ── RAPIDAPI ───────────────────────────────────────────────────────────────
function rapidFetch(host, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: urlPath, method: 'GET',
      headers: { 'X-RapidAPI-Key': RAPID_KEY, 'X-RapidAPI-Host': host }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad API response')); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('API timeout')); });
    req.end();
  });
}

function calcScore(rating, reviews) {
  return Math.round(Math.min((rating / 5) * 60, 60) + Math.min(Math.log10((reviews || 1) + 1) * 15, 40));
}

async function searchGoogle(query, location, limit, offset=0) {
  const params = new URLSearchParams({ query: `${query} in ${location}`, limit: String(Math.min(limit, 20)), language: 'en', region: 'us', offset: String(offset) });
  const data = await rapidFetch('local-business-data.p.rapidapi.com', '/search?' + params);
  return (data.data || []).map(b => ({
    id: 'g_' + (b.business_id || Math.random().toString(36).slice(2)),
    name: b.name || 'Unknown', cat: b.type || b.subtypes?.[0] || 'Business',
    phone: b.phone_number || '', website: b.website || '',
    address: b.full_address || b.address || '', city: b.city || location,
    state: b.state || '', zip: b.zipcode || '',
    rating: b.rating || 0, reviews: b.reviews || 0,
    hours: b.working_hours_old_format || '', source: 'Google Maps',
    score: calcScore(b.rating, b.reviews), notes: ''
  }));
}

// ── AUTH ROUTES ────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (users.has(email.toLowerCase())) return res.status(400).json({ error: 'An account with that email already exists' });
  const hashed = await bcrypt.hash(password, 10);
  const user = { email: email.toLowerCase(), password: hashed, plan: 'free', stripeCustomerId: null, createdAt: new Date().toISOString() };
  users.set(email.toLowerCase(), user);
  const token = jwt.sign({ email: email.toLowerCase(), plan: 'free' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: email.toLowerCase(), plan: 'free', planLabel: 'Free', limits: PLANS.free });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.get(email?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'No account found with that email' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });
  const token = jwt.sign({ email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: user.email, plan: user.plan, planLabel: PLANS[user.plan]?.label, limits: PLANS[user.plan] });
});

app.get('/api/me', auth, (req, res) => {
  const user = users.get(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ email: user.email, plan: user.plan, planLabel: PLANS[user.plan]?.label, limits: PLANS[user.plan] });
});

// ── UPDATE PROFILE ────────────────────────────────────────────────────────
app.post('/api/update-profile', auth, async (req, res) => {
  const { newEmail, newPassword, currentPassword } = req.body;
  const user = users.get(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Verify current password
  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  // Update email
  if (newEmail && newEmail !== user.email) {
    if (users.has(newEmail.toLowerCase())) return res.status(400).json({ error: 'That email is already taken' });
    users.delete(user.email);
    user.email = newEmail.toLowerCase();
    users.set(user.email, user);
  }

  // Update password
  if (newPassword) {
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    user.password = await bcrypt.hash(newPassword, 10);
  }

  const token = require('jsonwebtoken').sign({ email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, email: user.email, plan: user.plan, planLabel: PLANS[user.plan]?.label });
});

// ── USAGE STATS ────────────────────────────────────────────────────────────
app.get('/api/usage', auth, (req, res) => {
  const user = users.get(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const today = new Date().toISOString().slice(0, 10);
  const key = user.email + ':' + today;
  const used = dailyCounts.get(key) || 0;
  const plan = PLANS[user.plan] || PLANS.free;
  const limit = plan.dailySearches;
  const remaining = limit >= 999999 ? 999999 : Math.max(0, limit - used);
  res.json({ used, limit, remaining, plan: user.plan, planLabel: plan.label });
});

// ── STRIPE ─────────────────────────────────────────────────────────────────
app.post('/api/create-checkout', auth, async (req, res) => {
  const { plan } = req.body;
  const priceId = STRIPE_PRICES[plan];
  if (!priceId) return res.status(400).json({ error: 'Stripe not configured yet. See README for setup instructions.' });
  try {
    const user = users.get(req.user.email);
    if (!user.stripeCustomerId) {
      const customer = await stripe.customers.create({ email: user.email });
      user.stripeCustomerId = customer.id;
    }
    const session = await stripe.checkout.sessions.create({
      customer: user.stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.APP_URL || 'http://localhost:' + PORT}/?upgraded=true`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:' + PORT}/`
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch { return res.status(400).send('Webhook error'); }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    for (const [, user] of users) {
      if (user.stripeCustomerId === session.customer) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = sub.items.data[0].price.id;
        const plan = Object.entries(STRIPE_PRICES).find(([, p]) => p === priceId)?.[0] || 'basic';
        user.plan = plan;
        break;
      }
    }
  }
  res.json({ received: true });
});

// ── SEARCH ─────────────────────────────────────────────────────────────────
app.get('/api/search', auth, async (req, res) => {
  const { q, loc, limit, noWebsite } = req.query;
  if (!q || !loc) return res.status(400).json({ error: 'Missing search query or location' });
  const user = users.get(req.user.email);
  if (!user) return res.status(401).json({ error: 'User not found' });
  const planLimits = PLANS[user.plan] || PLANS.free;
  const targetLimit = Math.min(parseInt(limit) || 20, 100);
  const filterNoWebsite = noWebsite === 'true';

  if (!checkRateLimit(user.email, 10)) {
    return res.status(429).json({ error: 'Too many searches — wait a minute and try again' });
  }
  if (!checkDailyLimit(user.email, planLimits.dailySearches)) {
    return res.status(429).json({ error: `Daily search limit reached (${planLimits.dailySearches}/day on ${planLimits.label} plan). Upgrade for more.` });
  }

  const cacheKey = `${q.toLowerCase().trim()}:${loc.toLowerCase().trim()}:${targetLimit}:${filterNoWebsite}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${cacheKey}`);
    return res.json({ leads: cached, errors: [], total: cached.length, plan: user.plan, exportLimit: planLimits.exports, cached: true });
  }

  const errors = [];
  let leads = [];
  const seen = new Set();
  console.log(`[SEARCH] q="${q}" loc="${loc}" limit=${targetLimit} noWebsite=${filterNoWebsite}`);

  if (filterNoWebsite) {
    // Smart paginating fetch — keeps calling API in batches of 20 until we
    // collect enough no-website results or exhaust results (max 8 API calls)
    let offset = 0;
    let apiCalls = 0;
    const MAX_CALLS = 8;

    while (leads.length < targetLimit && apiCalls < MAX_CALLS) {
      try {
        const batch = await searchGoogle(q, loc, 20, offset);
        apiCalls++;
        if (!batch.length) break;
        for (const b of batch) {
          const key = (b.name + b.city).toLowerCase().replace(/\s/g, '');
          if (seen.has(key)) continue;
          seen.add(key);
          if (!b.website || !b.website.trim()) {
            leads.push(b);
            if (leads.length >= targetLimit) break;
          }
        }
        offset += 20;
        if (batch.length < 20) break;
      } catch(e) {
        errors.push(e.message);
        console.error('[SEARCH ERROR]', e.message);
        break;
      }
    }
    console.log(`[SEARCH] ${leads.length} no-website results in ${apiCalls} API calls`);
  } else {
    try {
      const batch = await searchGoogle(q, loc, targetLimit, 0);
      for (const b of batch) {
        const key = (b.name + b.city).toLowerCase().replace(/\s/g, '');
        if (!seen.has(key)) { seen.add(key); leads.push(b); }
      }
    } catch(e) {
      errors.push(e.message);
      console.error('[SEARCH ERROR]', e.message);
    }
  }

  if (!leads.length && errors.length) {
    return res.json({ leads: [], errors, total: 0, plan: user.plan, exportLimit: planLimits.exports, debug: errors.join(' | ') });
  }

  setCache(cacheKey, leads);
  res.json({ leads, errors, total: leads.length, plan: user.plan, exportLimit: planLimits.exports, filtered: filterNoWebsite });
});
// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── FRONTEND ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── WEBSOCKET CHAT ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Persistent chat history — saved to disk
const fs = require('fs');
const CHAT_FILE = './chat_history.json';
const MAX_HISTORY = 200;

function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_FILE)) return JSON.parse(fs.readFileSync(CHAT_FILE,'utf8'));
  } catch(e) {}
  return [];
}
function saveChatHistory(history) {
  try { fs.writeFileSync(CHAT_FILE, JSON.stringify(history)); } catch(e) {}
}
const chatHistory = loadChatHistory();
// Track connected users: ws -> {email, displayName}
const connectedUsers = new Map();

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(msg);
    }
  });
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function getOnlineUsers() {
  const names = [];
  connectedUsers.forEach(u => names.push(u.displayName));
  return names;
}

wss.on('connection', (ws, req) => {
  // Verify JWT from query param
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  let userInfo = { email: 'Anonymous', displayName: 'Anonymous' };

  if (token) {
    try {
      const decoded = require('jsonwebtoken').verify(token, JWT_SECRET);
      const email = decoded.email;
      // Create display name from email
      const name = email.split('@')[0].replace(/[._]/g,' ').replace(/\b\w/g, c => c.toUpperCase());
      userInfo = { email, displayName: name };
    } catch(e) {}
  }

  connectedUsers.set(ws, userInfo);

  // Send chat history to new user
  ws.send(JSON.stringify({ type: 'history', messages: chatHistory }));

  // Send online users list to all
  broadcastAll({ type: 'users', users: getOnlineUsers(), count: connectedUsers.size });

  // Notify join
  const joinMsg = { type: 'system', text: `${userInfo.displayName} joined the chat`, ts: Date.now() };
  broadcast(joinMsg, ws);

  ws.on('message', raw => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'message') {
        const text = String(data.text || '').trim().slice(0, 500);
        if (!text) return;
        const msg = {
          type: 'message',
          id: Date.now() + Math.random(),
          displayName: userInfo.displayName,
          email: userInfo.email,
          text,
          ts: Date.now()
        };
        chatHistory.push(msg);
        if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
        saveChatHistory(chatHistory);
        broadcastAll(msg);
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    connectedUsers.delete(ws);
    broadcast({ type: 'system', text: `${userInfo.displayName} left the chat`, ts: Date.now() });
    broadcastAll({ type: 'users', users: getOnlineUsers(), count: connectedUsers.size });
  });
});

server.listen(PORT, () => {
  console.log(`\n  ⚡ LeadGen Pro SaaS\n  Running at http://localhost:${PORT}\n`);
});
