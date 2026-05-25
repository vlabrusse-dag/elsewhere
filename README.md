# Elsewhere 🧭
> Discover the road less travelled. Fight overtourism, one hidden gem at a time.

## What it does
Users enter a famous tourist landmark → the app suggests a lesser-known alternative nearby, powered by Claude AI. The most liked suggestions rise to the top and appear as "you might also like" recommendations.

## Stack
- **Frontend**: Vanilla HTML/CSS/JS (zero dependencies)
- **Backend**: Vercel Serverless Function (Node.js) — one file
- **AI**: Anthropic Claude API (claude-sonnet)
- **Hosting**: Vercel (free tier)
- **Cost**: ~€0/month + ~€0.001 per search (API usage)

## Languages supported
English, French, Spanish, German, Italian, Portuguese, Japanese, Chinese, Arabic, Dutch — auto-detected from browser, switchable in header.

---

## Deploy in 10 minutes

### 1. Get your Anthropic API key
- Go to https://console.anthropic.com
- Create an account → API Keys → Create Key
- Copy the key (starts with `sk-ant-...`)

### 2. Push to GitHub
```bash
# In this folder:
git init
git add .
git commit -m "Initial commit — Elsewhere"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/elsewhere.git
git push -u origin main
```

### 3. Deploy on Vercel
1. Go to https://vercel.com → Sign up with GitHub (free)
2. Click "Add New Project" → Import your `elsewhere` repo
3. In "Environment Variables", add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key from step 1
4. Click Deploy → done ✓

Your site is live at `https://elsewhere-XXXX.vercel.app`

### 4. Custom domain (optional, ~€10/year)
In Vercel dashboard → Project → Settings → Domains → Add your domain.

---

## Likes persistence (upgrade path)

Currently, likes are stored in-memory (they reset on page refresh — fine for a prototype).

To persist likes across sessions, connect Google Sheets:

1. Create a Google Sheet with columns: `query | name | city | why | image | google | likes`
2. Enable Google Sheets API in Google Cloud Console
3. Create a Service Account → download credentials JSON
4. Add credentials as `GOOGLE_CREDENTIALS` env variable on Vercel
5. In `api/suggest.js`, add read/write calls to the sheet before/after each suggestion

I can generate this upgrade when you're ready.

---

## File structure
```
elsewhere/
├── index.html        ← Full frontend (HTML + CSS + JS, i18n, likes UI)
├── api/
│   └── suggest.js   ← Vercel serverless function (Claude API proxy)
├── vercel.json       ← Routing config
└── README.md
```
