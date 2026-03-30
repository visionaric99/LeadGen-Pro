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

// Use raw body for Stripe webhook, JSON for everything else
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe-webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});
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

// Test account — survives restarts for Stripe testing
users.set('test@leadgenpro.com', {
  email: 'test@leadgenpro.com',
  password: bcrypt.hashSync('Test1234!', 10),
  plan: 'pending',
  stripeCustomerId: null,
  createdAt: new Date().toISOString()
});

// ── PLANS ──────────────────────────────────────────────────────────────────
// No free tier — minimum $29/mo required to access the tool
const PLANS = {
  basic:  {
    exports: 999999, searchLimit: 100, dailyLeads: 100,
    bulkSearch: false, community: false, prioritySupport: false,
    label: 'Basic', price: 29
  },
  pro:    {
    exports: 999999, searchLimit: 100, dailyLeads: 500,
    bulkSearch: true, community: true, prioritySupport: true,
    label: 'Pro', price: 79
  },
  agency: {
    exports: 999999, searchLimit: 100, dailyLeads: 1000,
    bulkSearch: true, community: true, prioritySupport: true,
    label: 'Agency', price: 199
  }
};

// Admin override — your account bypasses all limits
const ADMIN_EMAILS = ['visionaricscaling@gmail.com'];

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
function getDailyLeadsUsed(email) {
  const today = new Date().toISOString().slice(0, 10);
  return dailyCounts.get(email + ':leads:' + today) || 0;
}

function addDailyLeads(email, count) {
  const today = new Date().toISOString().slice(0, 10);
  const key = email + ':leads:' + today;
  dailyCounts.set(key, (dailyCounts.get(key) || 0) + count);
}

function checkDailyLimit(email, limit) {
  if (ADMIN_EMAILS.includes(email)) return true;
  if (limit >= 999999) return true;
  const today = new Date().toISOString().slice(0, 10);
  const key = email + ':' + today;
  const count = dailyCounts.get(key) || 0;
  if (count >= limit) return false;
  dailyCounts.set(key, count + 1);
  return true;
}

// STRIPE_PRICES defined below in Stripe section

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please log in again' });
  }
}

function requirePlan(req, res, next) {
  const user = users.get(req.user?.email);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (ADMIN_EMAILS.includes(user.email)) return next();
  if (!user.plan || user.plan === 'pending') {
    return res.status(402).json({ error: 'Subscription required', requiresPayment: true });
  }
  next();
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

// ── REVENUE ESTIMATOR ──────────────────────────────────────────────────────
// Estimates monthly revenue tier based on category, rating, reviews, presence
const HIGH_VALUE_CATS = [
  'lawyer','attorney','law','legal','dentist','dental','orthodont','oral',
  'doctor','physician','medical','clinic','hospital','surgery','plastic',
  'accountant','accounting','cpa','financial','wealth','investment','insurance',
  'real estate','realtor','mortgage','property','contractor','construction',
  'roofing','plumber','plumbing','electrician','hvac','heating','cooling',
  'auto dealer','car dealer','dealership','mechanic','auto repair',
  'architect','engineering','consultant','consulting','marketing agency',
  'software','tech','it service','spa','medspa','med spa','chiropractor',
  'veterinarian','vet clinic','optometrist','pharmacy'
];

const MID_VALUE_CATS = [
  'restaurant','bar','cafe','catering','bakery','gym','fitness','yoga',
  'salon','barber','beauty','nail','massage','florist','jewelry','retail',
  'boutique','clothing','furniture','appliance','landscaping','cleaning',
  'moving','storage','printing','photography','videography','event',
  'daycare','school','tutor','hotel','motel','inn','vacation'
];

function estimateRevenue(name, cat, rating, reviews, hasWebsite) {
  const catLower = (cat || '').toLowerCase();
  const nameLower = (name || '').toLowerCase();
  const combined = catLower + ' ' + nameLower;

  // Base multiplier from category
  let base = 1.0;
  if (HIGH_VALUE_CATS.some(k => combined.includes(k))) base = 3.0;
  else if (MID_VALUE_CATS.some(k => combined.includes(k))) base = 1.8;

  // Rating signal — well-rated businesses are busier
  const ratingMult = rating >= 4.5 ? 1.4 : rating >= 4.0 ? 1.2 : rating >= 3.5 ? 1.0 : 0.8;

  // Review count signal — proxy for customer volume
  const reviewScore = Math.min(Math.log10((reviews || 1) + 1) / Math.log10(500), 1.0);
  const reviewMult = 0.6 + reviewScore * 0.8;

  // Website presence — established businesses have sites
  const webMult = hasWebsite ? 1.1 : 0.85;

  // Final score 0-100
  const score = Math.min(base * ratingMult * reviewMult * webMult * 33, 100);

  // Map to revenue tiers
  if (score >= 65) return 100000;  // $100K+/mo
  if (score >= 35) return 50000;   // $50K+/mo
  return 10000;                     // $10K+/mo
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
    score: calcScore(b.rating, b.reviews),
    estRevenue: estimateRevenue(b.name, b.type || b.subtypes?.[0], b.rating, b.reviews, !!(b.website)),
    notes: ''
  }));
}

// ── AUTH ROUTES ────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (users.has(email.toLowerCase())) return res.status(400).json({ error: 'An account with that email already exists' });
  const hashed = await bcrypt.hash(password, 10);
  // New users start as 'pending' — must subscribe before accessing the tool
  const user = { email: email.toLowerCase(), password: hashed, plan: 'pending', stripeCustomerId: null, createdAt: new Date().toISOString() };
  users.set(email.toLowerCase(), user);
  const token = jwt.sign({ email: email.toLowerCase(), plan: 'pending' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: email.toLowerCase(), plan: 'pending', planLabel: 'Choose a plan', requiresPayment: true });
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
  const isAdmin = ADMIN_EMAILS.includes(user.email);
  const plan = PLANS[user.plan];
  if (!plan) return res.json({ used: 0, limit: 0, remaining: 0, plan: user.plan, planLabel: 'No plan', requiresPayment: true });
  const used = isAdmin ? 0 : getDailyLeadsUsed(user.email);
  const limit = isAdmin ? 999999 : (plan.dailyLeads || 100);
  const remaining = isAdmin ? 999999 : Math.max(0, limit - used);
  res.json({ used, limit, remaining, plan: user.plan, planLabel: plan.label, features: plan });
});

// ── STRIPE ─────────────────────────────────────────────────────────────────
const STRIPE_PRICES = {
  basic:  process.env.STRIPE_PRICE_BASIC  || 'price_1TG1ZpR9NSYpy4Lohn26QWko',
  pro:    process.env.STRIPE_PRICE_PRO    || 'price_1TG1aNR9NSYpy4Lop8aYHn8t',
  agency: process.env.STRIPE_PRICE_AGENCY || 'price_1TG1avR9NSYpy4Lomvkb9gNG'
};

const APP_URL = process.env.APP_URL || 'https://leadgen-pro-production-2804.up.railway.app';

// Create Stripe checkout session
app.post('/api/create-checkout', auth, async (req, res) => {
  const { plan } = req.body;
  const priceId = STRIPE_PRICES[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });

  const user = users.get(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    // Create or retrieve Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { plan }
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${APP_URL}/?upgraded=true&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/?cancelled=true`,
      metadata: { email: user.email, plan },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('[STRIPE ERROR]', e.message);
    res.status(500).json({ error: 'Failed to create checkout: ' + e.message });
  }
});

// Stripe webhook — handles payment confirmation and subscription cancellation
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body);
      console.warn('[WEBHOOK] No webhook secret set — skipping signature verification');
    }
  } catch (e) {
    console.error('[WEBHOOK] Signature verification failed:', e.message);
    return res.status(400).send('Webhook error: ' + e.message);
  }

  console.log('[WEBHOOK] Event:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.metadata?.email || session.customer_email;
    const plan = session.metadata?.plan;

    if (email && plan && PLANS[plan]) {
      const user = users.get(email.toLowerCase());
      if (user) {
        user.plan = plan;
        user.stripeCustomerId = session.customer;
        user.stripeSubscriptionId = session.subscription;
        console.log(`[STRIPE] Upgraded ${email} to ${plan}`);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;
    // Find user by stripe customer ID
    for (const [email, user] of users.entries()) {
      if (user.stripeCustomerId === customerId) {
        user.plan = 'pending';
        user.stripeSubscriptionId = null;
        console.log(`[STRIPE] Cancelled subscription for ${email}`);
        break;
      }
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const customerId = sub.customer;
    // Handle plan changes
    for (const [email, user] of users.entries()) {
      if (user.stripeCustomerId === customerId) {
        const priceId = sub.items?.data?.[0]?.price?.id;
        const newPlan = Object.keys(STRIPE_PRICES).find(k => STRIPE_PRICES[k] === priceId);
        if (newPlan) {
          user.plan = newPlan;
          console.log(`[STRIPE] Updated ${email} plan to ${newPlan}`);
        }
        break;
      }
    }
  }

  res.json({ received: true });
});

// Get subscription status
app.get('/api/subscription', auth, async (req, res) => {
  const user = users.get(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    plan: user.plan,
    planLabel: PLANS[user.plan]?.label || 'No plan',
    email: user.email,
    stripeCustomerId: user.stripeCustomerId || null,
    features: PLANS[user.plan] || {}
  });
});
// ── SEARCH ─────────────────────────────────────────────────────────────────
app.get('/api/search', auth, requirePlan, async (req, res) => {
  const { q, loc, limit, noWebsite, minRevenue } = req.query;
  if (!q || !loc) return res.status(400).json({ error: 'Missing search query or location' });

  const user = users.get(req.user.email);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const isAdmin = ADMIN_EMAILS.includes(user.email);
  const planLimits = PLANS[user.plan] || PLANS.basic;
  const targetLimit = Math.min(parseInt(limit) || 20, 100);
  const filterNoWebsite = noWebsite === 'true';

  // Rate limit
  if (!checkRateLimit(user.email, 10)) {
    return res.status(429).json({ error: 'Too many searches — wait a minute and try again' });
  }

  // Daily lead cap
  const dailyLeadLimit = isAdmin ? 999999 : (planLimits.dailyLeads || 100);
  const leadsUsedToday = getDailyLeadsUsed(user.email);
  if (!isAdmin && leadsUsedToday >= dailyLeadLimit) {
    return res.status(429).json({
      error: `Daily lead limit reached (${dailyLeadLimit} leads/day on ${planLimits.label} plan). Resets at midnight.`,
      limitReached: true
    });
  }

  // Cache
  const cacheKey = `${q.toLowerCase().trim()}:${loc.toLowerCase().trim()}:${targetLimit}:${filterNoWebsite}`;
  const cached = getCached(cacheKey);
  if (cached) {
    let filteredCached = cached;
    if (minRevenue && parseInt(minRevenue) > 0) {
      filteredCached = cached.filter(l => (l.estRevenue || 10000) >= parseInt(minRevenue));
    }
    return res.json({ leads: filteredCached, errors: [], total: filteredCached.length, plan: user.plan, exportLimit: planLimits.exports, cached: true });
  }

  const errors = [];
  let leads = [];
  const seen = new Set();
  console.log(`[SEARCH] q="${q}" loc="${loc}" limit=${targetLimit} noWebsite=${filterNoWebsite} user=${user.email}`);

  try {
    if (filterNoWebsite) {
      let offset = 0, apiCalls = 0;
      while (leads.length < targetLimit && apiCalls < 8) {
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
      }
      console.log(`[SEARCH] ${leads.length} no-website results in ${apiCalls} API calls`);
    } else {
      const batch = await searchGoogle(q, loc, targetLimit, 0);
      for (const b of batch) {
        const key = (b.name + b.city).toLowerCase().replace(/\s/g, '');
        if (!seen.has(key)) { seen.add(key); leads.push(b); }
      }
    }
  } catch(e) {
    errors.push(e.message);
    console.error('[SEARCH ERROR]', e.message);
  }

  if (!leads.length && errors.length) {
    return res.json({ leads: [], errors, total: 0, plan: user.plan, exportLimit: planLimits.exports, debug: errors.join(' | ') });
  }

  setCache(cacheKey, leads);

  // Track leads toward daily cap
  if (!isAdmin) addDailyLeads(user.email, leads.length);

  // Apply revenue filter
  let finalLeads = leads;
  if (minRevenue && parseInt(minRevenue) > 0) {
    finalLeads = leads.filter(l => (l.estRevenue || 10000) >= parseInt(minRevenue));
  }

  res.json({ leads: finalLeads, errors, total: finalLeads.length, plan: user.plan, exportLimit: planLimits.exports, filtered: filterNoWebsite });
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
