const express = require('express');
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

async function searchGoogle(query, location, limit) {
  const params = new URLSearchParams({ query: `${query} in ${location}`, limit: String(Math.min(limit, 100)), language: 'en', region: 'us' });
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
  const { q, loc, limit } = req.query;
  if (!q || !loc) return res.status(400).json({ error: 'Missing search query or location' });
  const user = users.get(req.user.email);
  if (!user) return res.status(401).json({ error: 'User not found' });
  const planLimits = PLANS[user.plan] || PLANS.free;

  // Rate limit — max 10 searches per minute per user
  if (!checkRateLimit(user.email, 10)) {
    return res.status(429).json({ error: 'Too many searches — wait a minute and try again' });
  }

  // Daily search cap per plan
  if (!checkDailyLimit(user.email, planLimits.dailySearches)) {
    return res.status(429).json({ error: `Daily search limit reached (${planLimits.dailySearches}/day on ${planLimits.label} plan). Upgrade for more.` });
  }

  // Check cache first — saves API calls
  const cacheKey = `${q.toLowerCase().trim()}:${loc.toLowerCase().trim()}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${cacheKey}`);
    return res.json({ leads: cached, errors: [], total: cached.length, plan: user.plan, exportLimit: planLimits.exports, cached: true });
  }

  const errors = [];
  let leads = [];
  console.log(`[SEARCH] q="${q}" loc="${loc}" user=${user.email}`);
  try {
    leads = await searchGoogle(q, loc, 100);
    console.log(`[SEARCH] got ${leads.length} results`);
  } catch(e) {
    console.error('[SEARCH ERROR]', e.message);
    errors.push(e.message);
  }

  if (!leads.length && errors.length) {
    return res.json({ leads: [], errors, total: 0, plan: user.plan, exportLimit: planLimits.exports, debug: errors.join(' | ') });
  }

  // Deduplicate
  const seen = new Set();
  leads = leads.filter(l => {
    const key = (l.name + l.city).toLowerCase().replace(/\s/g, '');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  // Cache the result
  setCache(cacheKey, leads);

  res.json({ leads, errors, total: leads.length, plan: user.plan, exportLimit: planLimits.exports });
});

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── FRONTEND ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  ⚡ LeadGen Pro SaaS\n  Running at http://localhost:${PORT}\n`);
});
