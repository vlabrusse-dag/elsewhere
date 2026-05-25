// api/suggest.js — Vercel Serverless Function
// Rate limiting: 5 req/min and 20 req/hour per IP (in-memory, no external deps)

// ── RATE LIMITER ──────────────────────────────────────────────────────────────
// Stored as: { ip -> { min: { count, resetAt }, hour: { count, resetAt } } }
const ipStore = new Map();

const LIMITS = {
  perMinute: 5,
  perHour: 20,
};

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
    const retryAfter = Math.ceil((entry.min.resetAt - now) / 1000);
    return { blocked: true, reason: 'minute', retryAfter };
  }
  if (entry.hour.count > LIMITS.perHour) {
    const retryAfter = Math.ceil((entry.hour.resetAt - now) / 1000);
    return { blocked: true, reason: 'hour', retryAfter };
  }

  // Cleanup old IPs every ~500 requests to avoid memory leak
  if (ipStore.size > 500) {
    for (const [k, v] of ipStore) {
      if (now > v.hour.resetAt) ipStore.delete(k);
    }
  }

  return { blocked: false };
}

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Rate limit check
  const ip = getIP(req);
  const limit = checkRateLimit(ip);

  if (limit.blocked) {
    res.setHeader('Retry-After', limit.retryAfter);
    res.setHeader('X-RateLimit-Limit', limit.reason === 'minute' ? LIMITS.perMinute : LIMITS.perHour);
    res.setHeader('X-RateLimit-Window', limit.reason === 'minute' ? '60s' : '3600s');
    return res.status(429).json({
      error: 'rate_limited',
      reason: limit.reason,
      retryAfter: limit.retryAfter,
      message: limit.reason === 'minute'
        ? `Too many requests. Please wait ${limit.retryAfter} seconds.`
        : `Hourly limit reached. Please wait ${Math.ceil(limit.retryAfter / 60)} minutes.`,
    });
  }

  // ── Input validation
  const { query, contextHint = '', lang = 'en' } = req.body || {};

  if (!query || typeof query !== 'string' || query.trim().length < 2 || query.length > 200) {
    return res.status(400).json({ error: 'Invalid query' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // ── Claude prompt
  const langInstruction = lang !== 'en'
    ? `IMPORTANT: Write the "why" field in the language with code "${lang}". Write "name" and "city" in their native local language (or English if widely used). All other fields remain as-is.`
    : '';

  const SYSTEM = `You are an expert in alternative and sustainable tourism. When given a famous tourist spot, suggest ONE hidden gem alternative — lesser-known, off the beaten path, genuinely special.

Rules:
- ONLY suggest truly hidden, uncrowded, secret places.
- NEVER suggest famous, popular, or crowded places.
- Stay in the same city, region, or country as the input.
- Match the experience type (viewpoint, nature, architecture, history, art, food, etc).
- The image field must be a REAL, working direct image URL from Unsplash (https://images.unsplash.com/photo-XXXXXX?w=800&q=80) or Wikimedia Commons. Use real, valid photo IDs — do not invent URLs.
- The google field must be: https://www.google.com/search?q=PLACE+NAME+CITY (URL-encoded spaces as +).
${langInstruction}

Respond ONLY with a valid JSON object — no markdown, no backticks, no explanation before or after:
{
  "name": "Place name",
  "city": "City or region",
  "why": "2-3 sentence explanation of why this is a great alternative and what makes it special",
  "image": "Direct image URL",
  "google": "https://www.google.com/search?q=..."
}`;

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
        system: SYSTEM,
        messages: [{ role: 'user', content: `Famous tourist spot: ${query.trim()}${contextHint}` }],
      }),
    });

    if (!anthropicRes.ok) {
      console.error('Anthropic API error:', await anthropicRes.text());
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

    if (!parsed.name || !parsed.city || !parsed.why) {
      return res.status(502).json({ error: 'Incomplete response from model' });
    }

    if (!parsed.google?.startsWith('https://')) {
      parsed.google = `https://www.google.com/search?q=${encodeURIComponent(parsed.name + ' ' + parsed.city)}`;
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
