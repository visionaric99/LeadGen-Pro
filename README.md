# LeadGen Pro — SaaS Setup Guide

## Folder structure
```
leadgen-pro/
├── server.js
├── package.json
├── README.md
└── public/
    └── index.html
```

## Step 1 — Deploy to Railway (free)

1. Go to github.com → New repository → name it `leadgen-pro` → Create
2. Upload all files keeping the folder structure above
3. Go to railway.app → Sign in with GitHub → New Project → Deploy from GitHub repo
4. Select your `leadgen-pro` repo → Railway auto-detects Node.js and deploys
5. Click your deployment → Settings → Generate Domain → copy your live URL

## Step 2 — Set environment variables on Railway

In Railway → your project → Variables → add these:

```
RAPID_KEY = 329f1147c9msh86f85560447ea6ap15a93djsnf892c1bfece5
JWT_SECRET = pick-any-random-long-string-here
APP_URL = https://your-app.up.railway.app
STRIPE_SECRET_KEY = sk_live_... (from Stripe dashboard)
STRIPE_PRICE_BASIC = price_... (from Stripe dashboard)
STRIPE_PRICE_PRO = price_... (from Stripe dashboard)
STRIPE_PRICE_AGENCY = price_... (from Stripe dashboard)
STRIPE_WEBHOOK_SECRET = whsec_... (from Stripe dashboard)
```

## Step 3 — Set up Stripe (takes 10 min)

1. Go to stripe.com → sign up free
2. Dashboard → Products → Add Product:
   - Name: "LeadGen Pro Basic" → Price: $29/month recurring → Save
   - Copy the Price ID (starts with price_...) → paste as STRIPE_PRICE_BASIC
   - Repeat for Pro ($79/mo) and Agency ($199/mo)
3. Developers → API Keys → copy Secret Key → paste as STRIPE_SECRET_KEY
4. Developers → Webhooks → Add endpoint:
   - URL: https://your-app.up.railway.app/api/stripe-webhook
   - Events: checkout.session.completed
   - Copy Signing Secret → paste as STRIPE_WEBHOOK_SECRET

## Your admin account
Default admin login (change the password!):
- Email: admin@leadgenpro.com
- Password: admin123

## Sending your link
Once deployed, just send: https://your-app.up.railway.app
Anyone can sign up, search for free, and upgrade to export leads.
