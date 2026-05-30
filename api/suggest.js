// api/suggest.js — Vercel Serverless Function
// v2: robust prompt + real images (Unsplash + Wikimedia fallback)

// ── RATE LIMITER ─────────────────────────────────────────────────────────────
const ipStore = new Map();
const LIMITS = { perMinute: 5, perHour: 20 };

function checkRateLimit(ip) {
  const now = Date.now();
  if (!ipStore.has(ip)) {
    ipStore.set(ip, {
      min:  { count: 0, resetAt: now + 60_000 },
      hour: { count: 0, resetAt: now + 3_600_000 },
    });
  }
  const entry = ipStore.get(ip);
  if (now > entry.min.resetAt)  entry.min  = { count: 0, resetAt: now + 60_000 };
  if (now > entry.hour.resetAt) entry.hour = { count: 0, resetAt: now + 3_600_000 };
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

// ── IMAGE SEARCH ─────────────────────────────────────────────────────────────
async function getUnsplashImage(query) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${key}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const photo = data.results?.[0];
    if (!photo) return null;
    return photo.urls?.regular || null;
  } catch { return null; }
}

async function getWikimediaImage(query) {
  try {
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const title = searchData.query?.search?.[0]?.title;
    if (!title) return null;

    const imgRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&pithumbsize=800&format=json&origin=*`
    );
    if (!imgRes.ok) return null;
    const imgData = await imgRes.json();
    const pages = imgData.query?.pages || {};
    const page = Object.values(pages)[0];
    return page?.thumbnail?.source || null;
  } catch { return null; }
}

async function findImage(name, city) {
  // Try Unsplash first with specific query, then broader, then Wikimedia
  const unsplash = await getUnsplashImage(`${name} ${city}`)
    || await getUnsplashImage(name);
  if (unsplash) return unsplash;
  return await getWikimediaImage(`${name} ${city}`) || null;
}

// ── CLAUDE PROMPT v2 ──────────────────────────────────────────────────────────
function buildSystem(lang) {
  const langInstruction = lang !== 'en'
    ? `LANGUAGE: Write the "why" field in language code "${lang}". Write "name" and "city" in their native local language. Keep all other fields in English.`
    : '';

  return `You are an expert in alternative sustainable tourism. Your role is to suggest ONE truly hidden, secret alternative to famous tourist spots.

STEP 1 — VALIDATE THE INPUT
First, determine if the input is:
A) A specific tourist attraction or landmark (Eiffel Tower, Louvre, Central Park) → proceed to suggest an alternative
B) A city or region (Paris, Tokyo, Tuscany) → suggest a lesser-known CITY or REGION with a similar character, NOT a specific spot within the same city
C) Complete nonsense or not a place at all (banana, hello, xyz123) → return an error response

If the input is (C), respond ONLY with this exact JSON:
{"error": "not_a_place", "message": "This doesn't seem to be a tourist destination. Please enter a landmark, attraction, or city."}

STEP 2 — SUGGEST AN ALTERNATIVE
Rules (strictly enforced):
- HIDDEN & RARE: The place must be genuinely obscure. Not just "less popular" — truly off the radar. A local secret. Somewhere that doesn't appear on major tourist lists.
- SAME CATEGORY: Match the type exactly:
  * Museum → another museum (not a park)
  * Garden/park → another garden or park (not a monument)
  * Viewpoint → another viewpoint
  * Religious building → another religious building
  * Palace/castle → another palace or castle
  * Beach → another beach
  * City → another city with similar character (not a neighborhood in the same city)
- PROXIMITY: Stay within the same city or within ~50km radius maximum. For cities/regions, stay within the same country or neighboring country.
- NEVER suggest: anything that appears in mainstream travel guides, top 10 lists, or has more than moderate tourist traffic.

${langInstruction}

Respond ONLY with valid JSON, no markdown, no backticks:
{
  "name": "Place name",
  "city": "City or region",
  "why": "2-3 sentences explaining why this is a great hidden alternative and what makes it genuinely special",
  "google": "https://www.google.com/search?q=PLACE+CITY"
}`;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit
  const ip = getIP(req);
  const limit = checkRateLimit(ip);
  if (limit.blocked) {
    res.setHeader('Retry-After', limit.retryAfter);
    return res.status(429).json({
      error: 'rate_limited',
      reason: limit.reason,
      retryAfter: limit.retryAfter,
      message: limit.reason === 'minute'
        ? `Too many requests. Please wait ${limit.retryAfter} seconds.`
        : `Hourly limit reached. Please wait ${Math.ceil(limit.retryAfter / 60)} minutes.`,
    });
  }

  // Validate input
  const { query, contextHint = '', lang = 'en' } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length < 2 || query.length > 200) {
    return res.status(400).json({ error: 'Invalid query' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // Call Claude
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
          content: `Tourist input: "${query.trim()}"${contextHint ? `\n\nAlready suggested: ${contextHint}` : ''}`
        }],
      }),
    });

    if (!anthropicRes.ok) {
      console.error('Anthropic error:', await anthropicRes.text());
      return res.status(502).json({ error: 'Upstream API error' });
    }

    const data = await anthropicRes.json();
    const raw = data.content?.[0]?.text || '';

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('JSON parse error:', raw);
      return res.status(502).json({ error: 'Invalid JSON from model' });
    }

    // Handle "not a place" error from Claude
    if (parsed.error === 'not_a_place') {
      return res.status(422).json(parsed);
    }

    if (!parsed.name || !parsed.city || !parsed.why) {
      return res.status(502).json({ error: 'Incomplete response from model' });
    }

    // Fix google URL
    if (!parsed.google?.startsWith('https://')) {
      parsed.google = `https://www.google.com/search?q=${encodeURIComponent(parsed.name + ' ' + parsed.city)}`;
    }

    // Fetch real image in parallel
    parsed.image = await findImage(parsed.name, parsed.city);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
