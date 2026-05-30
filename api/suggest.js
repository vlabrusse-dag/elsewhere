// api/suggest.js — Vercel Serverless Function
// v2.8.0 — Claude provides image URL directly, Unsplash fallback

// ── RATE LIMITER ─────────────────────────────────────────────────────────────
const ipStore = new Map();
const LIMITS = { perMinute: 5, perHour: 20 };

function checkRateLimit(ip) {
  const now = Date.now();
  if (!ipStore.has(ip)) {
    ipStore.set(ip, {
      min:  { count: 0, resetAt: now + 60000 },
      hour: { count: 0, resetAt: now + 3600000 },
    });
  }
  const entry = ipStore.get(ip);
  if (now > entry.min.resetAt)  entry.min  = { count: 0, resetAt: now + 60000 };
  if (now > entry.hour.resetAt) entry.hour = { count: 0, resetAt: now + 3600000 };
  entry.min.count++;
  entry.hour.count++;
  if (entry.min.count > LIMITS.perMinute) {
    return { blocked: true, reason: 'minute', retryAfter: Math.ceil((entry.min.resetAt - now) / 1000) };
  }
  if (entry.hour.count > LIMITS.perHour) {
    return { blocked: true, reason: 'hour', retryAfter: Math.ceil((entry.hour.resetAt - now) / 1000) };
  }
  if (ipStore.size > 500) {
    for (const [k, v] of ipStore) { if (now > v.hour.resetAt) ipStore.delete(k); }
  }
  return { blocked: false };
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

// ── IMAGE ─────────────────────────────────────────────────────────────────────
const UNSPLASH_SAFE_BLOCKLIST = ['mus', 'museum', 'musée', 'museo', 'gallery', 'galerie'];

function isUnsplashSafe(name) {
  const lower = name.toLowerCase();
  return !UNSPLASH_SAFE_BLOCKLIST.some(function(c) {
    return lower.startsWith(c) || lower.includes(' ' + c);
  });
}

async function getUnsplashImage(query, category) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;
  try {
    const q = category ? (query + ' ' + category) : query;
    const res = await fetch(
      'https://api.unsplash.com/search/photos?query=' + encodeURIComponent(q) +
      '&per_page=5&orientation=landscape&content_filter=high',
      { headers: { Authorization: 'Client-ID ' + key }, signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const photo = data.results && data.results[0];
    return (photo && photo.urls && photo.urls.regular) || null;
  } catch (e) { return null; }
}

async function validateImageUrl(url) {
  // Only validate Wikimedia Commons URLs — they follow a predictable pattern
  if (!url) return false;
  if (url.includes('upload.wikimedia.org') || url.includes('commons.wikimedia.org')) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch (e) { return false; }
  }
  // For other URLs (Unsplash etc.) trust them
  return true;
}

async function findImage(name, city, country, imageUrl) {
  country = country || '';

  // Step 1: Use Claude-provided URL if valid
  if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('https://')) {
    const valid = await validateImageUrl(imageUrl);
    if (valid) return imageUrl;
  }

  // Step 2: Unsplash for non-museums
  if (!isUnsplashSafe(name)) return null;
  const words = name.trim().split(' ').filter(function(w) { return w.length > 2; });
  if (words.length >= 2) {
    const img = await getUnsplashImage(name + ' ' + city + ' ' + country, 'architecture landmark');
    if (img) return img;
  }

  return null;
}

// ── PROMPT ────────────────────────────────────────────────────────────────────
function buildSystem(lang) {
  const langInstruction = lang !== 'en'
    ? 'LANGUAGE: Write the "why" field in language code "' + lang + '". Write "name" and "city" in their native local language. Keep all other fields in English.'
    : '';

  return 'You are an expert in alternative sustainable tourism. Your role is to suggest ONE truly hidden, secret alternative to famous tourist spots.\n\n'
    + 'STEP 1 — IDENTIFY THE INPUT PRECISELY\n'
    + 'Before anything else, identify exactly what the user entered:\n'
    + '- Determine the EXACT name of the place, its COUNTRY, and its approximate location.\n'
    + '- If the place is ambiguous (e.g. "Rochefort" exists in France, Belgium, and elsewhere), default to the most well-known version and note the country.\n'
    + '- If the input is not a real place or tourist destination (random text, food items, etc.), respond ONLY with:\n'
    + '{"error": "not_a_place", "message": "This doesn\'t seem to be a tourist destination. Please enter a landmark, attraction, or city."}\n\n'
    + 'STEP 2 — CLASSIFY THE INPUT TYPE\n'
    + 'A) Specific attraction or landmark → suggest a hidden alternative of the SAME TYPE within 20km maximum\n'
    + 'B) City or town → suggest a lesser-known CITY or TOWN with similar character, same region\n'
    + 'C) Region or country → suggest a lesser-known region with similar character, same country\n\n'
    + 'STEP 3 — SUGGEST AN ALTERNATIVE\n\n'
    + 'GEOGRAPHY — NON-NEGOTIABLE:\n'
    + '- The alternative MUST be in the same country as the input.\n'
    + '- Type A: maximum 20km from the original. Never suggest something in another département or province.\n'
    + '- Type B/C: same region or adjacent region, strictly same country.\n\n'
    + 'CATEGORY MATCH — STRICT:\n'
    + '- Medieval town → another medieval town\n'
    + '- Museum → another museum of similar theme\n'
    + '- Garden/park → another garden or park\n'
    + '- Viewpoint → another viewpoint\n'
    + '- Religious building → another religious building\n'
    + '- Castle/château → another castle or fortified site\n'
    + '- Beach → another beach on the same coastline\n'
    + '- City → another city with similar size, vibe, and character\n\n'
    + 'HIDDEN & GENUINELY RARE:\n'
    + '- Truly obscure — not just "less visited" but genuinely off the radar.\n'
    + '- Must NOT appear on mainstream top-10 lists or Lonely Planet highlights.\n\n'
    + 'IMAGE — CRITICAL:\n'
    + 'For the "image" field, provide a REAL, WORKING direct image URL of THE PLACE YOU ARE SUGGESTING (NOT the input place).\n'
    + '1. Wikimedia Commons: https://upload.wikimedia.org/wikipedia/commons/[path]/[filename] — only if you are 100% certain of the exact URL\n'
    + '2. Leave as null if you are not certain — do NOT invent URLs, do NOT provide an image of the original famous place\n\n'
    + langInstruction + '\n\n'
    + 'Respond ONLY with valid JSON, no markdown, no backticks:\n'
    + '{\n'
    + '  "name": "Place name",\n'
    + '  "city": "City or nearest town",\n'
    + '  "country": "Country name in English",\n'
    + '  "why": "2-3 sentences explaining why this is a great hidden alternative and what makes it genuinely special",\n'
    + '  "google": "https://www.google.com/search?q=PLACE+CITY+COUNTRY",\n'
    + '  "image": "Direct image URL or null"\n'
    + '}';
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getIP(req);
  const limit = checkRateLimit(ip);
  if (limit.blocked) {
    res.setHeader('Retry-After', limit.retryAfter);
    return res.status(429).json({
      error: 'rate_limited',
      reason: limit.reason,
      retryAfter: limit.retryAfter,
      message: limit.reason === 'minute'
        ? 'Too many requests. Please wait ' + limit.retryAfter + ' seconds.'
        : 'Hourly limit reached. Please wait ' + Math.ceil(limit.retryAfter / 60) + ' minutes.',
    });
  }

  const { query, contextHint = '', lang = 'en' } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length < 2 || query.length > 200) {
    return res.status(400).json({ error: 'Invalid query' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: buildSystem(lang),
        messages: [{
          role: 'user',
          content: 'Tourist input: "' + query.trim() + '"' + (contextHint ? '\n\nAlready suggested: ' + contextHint : ''),
        }],
      }),
    });

    if (!anthropicRes.ok) {
      console.error('Anthropic error:', await anthropicRes.text());
      return res.status(502).json({ error: 'Upstream API error' });
    }

    const data = await anthropicRes.json();
    const raw = (data.content && data.content[0] && data.content[0].text) || '';

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('JSON parse error:', raw);
      return res.status(502).json({ error: 'Invalid JSON from model' });
    }

    if (parsed.error === 'not_a_place') {
      return res.status(422).json(parsed);
    }

    if (!parsed.name || !parsed.city || !parsed.why) {
      return res.status(502).json({ error: 'Incomplete response from model' });
    }

    if (!parsed.google || !parsed.google.startsWith('https://')) {
      parsed.google = 'https://www.google.com/search?q=' + encodeURIComponent((parsed.name || '') + ' ' + (parsed.city || '') + ' ' + (parsed.country || ''));
    }

    console.log('[IMG] Claude image field:', parsed.image);
    parsed.image = await findImage(parsed.name, parsed.city, parsed.country || '', parsed.image || null);
    console.log('[IMG] final image:', parsed.image ? 'found' : 'null');

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
