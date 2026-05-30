// api/suggest.js — Vercel Serverless Function
// v1.5.0 — Prompt v3 + real images (Wikimedia priority + Unsplash fallback)

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

// ── COUNTRY → WIKIPEDIA LANGUAGE MAP ─────────────────────────────────────────
const COUNTRY_LANG_MAP = {
  'france': 'fr', 'french': 'fr',
  'espagne': 'es', 'spain': 'es', 'españa': 'es',
  'italie': 'it', 'italy': 'it', 'italia': 'it',
  'portugal': 'pt', 'brasil': 'pt', 'brazil': 'pt',
  'allemagne': 'de', 'germany': 'de', 'deutschland': 'de',
  'autriche': 'de', 'austria': 'de',
  'suisse': 'de', 'switzerland': 'de',
  'pays-bas': 'nl', 'netherlands': 'nl', 'holland': 'nl',
  'belgique': 'nl', 'belgium': 'nl',
  'suède': 'sv', 'sweden': 'sv',
  'norvège': 'no', 'norway': 'no',
  'danemark': 'da', 'denmark': 'da',
  'finlande': 'fi', 'finland': 'fi',
  'russie': 'ru', 'russia': 'ru',
  'pologne': 'pl', 'poland': 'pl',
  'tchéquie': 'cs', 'czechia': 'cs',
  'japon': 'ja', 'japan': 'ja',
  'chine': 'zh', 'china': 'zh',
  'corée': 'ko', 'korea': 'ko',
  'maroc': 'ar', 'morocco': 'ar',
  'egypte': 'ar', 'egypt': 'ar',
  'tunisie': 'ar', 'tunisia': 'ar',
  'grèce': 'el', 'greece': 'el',
  'turquie': 'tr', 'turkey': 'tr',
  'inde': 'hi', 'india': 'hi',
  'uk': 'en', 'united kingdom': 'en', 'england': 'en',
  'usa': 'en', 'united states': 'en', 'australia': 'en',
};

function detectWikiLangs(city, country) {
  const lower = [(city || ''), (country || '')].join(' ').toLowerCase();
  for (const [keyword, lang] of Object.entries(COUNTRY_LANG_MAP)) {
    if (lower.includes(keyword)) {
      const langs = [lang];
      if (lang !== 'en') langs.push('en');
      if (lang !== 'fr' && lang !== 'en') langs.push('fr');
      return langs;
    }
  }
  return ['en', 'fr'];
}

// ── IMAGE BLOCKLIST ───────────────────────────────────────────────────────────
const IMG_BLOCKLIST = [
  'logo', 'icon', 'flag', 'coat', 'arms', 'portrait', 'map', 'locator',
  'restaurant', 'menu', 'food', 'dish', 'cuisine', 'chef',
  'person', 'people', 'face', 'headshot', 'biography', 'actor', 'actress',
  'politician', 'minister', 'president', 'mayor', 'singer', 'writer',
  'symbol', 'emblem', 'stamp', 'seal', 'signature',
  '.svg', 'commons-logo', 'wikidata', 'wikimedia',
  'photo_de', 'photo_du', 'photo_of',
];

function isGoodPlaceImage(url, width, height) {
  if (!url) return false;
  if (width && width < 300) return false;
  // Reject portrait-oriented images (taller than wide = likely a person photo)
  if (width && height && height > width * 1.8) return false; // block only extreme portraits (people), not building facades
  const lower = url.toLowerCase();
  return !IMG_BLOCKLIST.some(function(bad) { return lower.includes(bad); });
}

// ── IMAGE SEARCH ─────────────────────────────────────────────────────────────

// Wikidata P18 image lookup — most reliable for named institutions

// Get Wikidata entity ID from a Wikipedia article title
async function getWikidataIdFromWikipedia(title, lang) {
  try {
    const res = await fetch(
      'https://' + lang + '.wikipedia.org/w/api.php?action=query&titles=' +
      encodeURIComponent(title) +
      '&prop=pageprops&ppprop=wikibase_item&format=json&origin=*'
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pages = (data.query && data.query.pages) || {};
    const page = Object.values(pages)[0];
    return (page && page.pageprops && page.pageprops.wikibase_item) || null;
  } catch (e) { return null; }
}

// Get P18 image from a Wikidata entity ID
async function getP18Image(entityId) {
  try {
    const res = await fetch(
      'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' +
      entityId + '&props=claims&format=json&origin=*'
    );
    if (!res.ok) return null;
    const data = await res.json();
    const entity = data.entities && data.entities[entityId];
    if (!entity || !entity.claims || !entity.claims.P18) return null;
    const filename = entity.claims.P18[0] &&
      entity.claims.P18[0].mainsnak &&
      entity.claims.P18[0].mainsnak.datavalue &&
      entity.claims.P18[0].mainsnak.datavalue.value;
    if (!filename) return null;
    return await getWikimediaFileUrl(filename);
  } catch (e) { return null; }
}

async function getWikidataImage(name, city, country) {
  try {
    // Try FR then EN wikipedia, name alone then name+city
    const attempts = [
      { lang: 'fr', q: name },
      { lang: 'en', q: name },
      { lang: 'fr', q: name + ' ' + (city || '') },
      { lang: 'en', q: name + ' ' + (city || '') },
      { lang: 'fr', q: stripAccents(name) },
    ];

    for (let i = 0; i < attempts.length; i++) {
      const lang = attempts[i].lang;
      const q = attempts[i].q.trim();
      if (!q) continue;

      console.log('[WD] attempt', i, lang, q);

      const r1 = await fetch(
        'https://' + lang + '.wikipedia.org/w/api.php?action=query&list=search' +
        '&srsearch=' + encodeURIComponent(q) +
        '&format=json&origin=*&srnamespace=0&srlimit=3'
      );
      if (!r1.ok) { console.log('[WD] search fail', r1.status); continue; }
      const d1 = await r1.json();
      const hits = (d1.query && d1.query.search) || [];
      console.log('[WD] hits:', hits.map(function(h){return h.title;}));
      if (!hits.length) continue;

      const title = hits[0].title;
      const entityId = await getWikidataIdFromWikipedia(title, lang);
      console.log('[WD] entityId:', entityId);
      if (!entityId) continue;

      const img = await getP18Image(entityId);
      console.log('[WD] img:', img ? img.slice(0, 60) : null);
      if (img && isGoodPlaceImage(img, 800, 500)) return img;
    }
    console.log('[WD] no image found for:', name);
    return null;
  } catch (e) {
    console.log('[WD] exception:', e.message);
    return null;
  }
}

async function getUnsplashImage(query, category) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;
  try {
    const q = category ? (query + ' ' + category) : query;
    const res = await fetch(
      'https://api.unsplash.com/search/photos?query=' + encodeURIComponent(q) + '&per_page=5&orientation=landscape&content_filter=high',
      { headers: { Authorization: 'Client-ID ' + key } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const photo = data.results && data.results[0];
    if (!photo) return null;
    return photo.urls && photo.urls.regular || null;
  } catch (e) { return null; }
}

async function searchWikiLang(lang, q) {
  const base = 'https://' + lang + '.wikipedia.org/w/api.php';
  try {
    const searchRes = await fetch(
      base + '?action=query&list=search&srsearch=' + encodeURIComponent(q) + '&format=json&origin=*&srnamespace=0&srlimit=5'
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const results = (searchData.query && searchData.query.search) || [];
    const title = results.find(function(r) {
      return !r.title.includes('(disambiguation)')
        && !r.title.includes('(homonymie)')
        && !r.title.includes('List of')
        && !r.title.toLowerCase().includes('restaurant')
        && !r.title.toLowerCase().includes('cuisine')
        && !r.title.toLowerCase().includes('canton')
        && !r.title.toLowerCase().includes('arrondissement');
    });
    if (!title) return null;
    const t = title.title;

    // Try infobox image first
    const imgRes = await fetch(
      base + '?action=query&titles=' + encodeURIComponent(t) + '&prop=pageimages&piprop=original|thumbnail&pithumbsize=1000&format=json&origin=*'
    );
    if (!imgRes.ok) return null;
    const imgData = await imgRes.json();
    const pages = (imgData.query && imgData.query.pages) || {};
    const page = Object.values(pages)[0];
    const src = (page && page.original && page.original.source) || (page && page.thumbnail && page.thumbnail.source);
    const width = (page && page.original && page.original.width) || (page && page.thumbnail && page.thumbnail.width);
    const height = (page && page.original && page.original.height) || (page && page.thumbnail && page.thumbnail.height);
    if (isGoodPlaceImage(src, width, height)) return src;

    // Scan all article images
    const allImgRes = await fetch(
      base + '?action=query&titles=' + encodeURIComponent(t) + '&prop=images&imlimit=20&format=json&origin=*'
    );
    if (!allImgRes.ok) return null;
    const allImgData = await allImgRes.json();
    const allPages = (allImgData.query && allImgData.query.pages) || {};
    const images = (Object.values(allPages)[0] && Object.values(allPages)[0].images) || [];
    const candidates = images.map(function(i) { return i.title; }).filter(function(t2) {
      const lower = t2.toLowerCase();
      return !IMG_BLOCKLIST.some(function(bad) { return lower.includes(bad); })
        && (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png'));
    });

    for (let i = 0; i < Math.min(candidates.length, 5); i++) {
      const infoRes = await fetch(
        'https://en.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(candidates[i]) + '&prop=imageinfo&iiprop=url|size|dimensions&iiurlwidth=1000&format=json&origin=*'
      );
      if (!infoRes.ok) continue;
      const infoData = await infoRes.json();
      const infoPages = (infoData.query && infoData.query.pages) || {};
      const info = Object.values(infoPages)[0];
      const imageinfo = info && info.imageinfo && info.imageinfo[0];
      if (imageinfo && imageinfo.thumburl && isGoodPlaceImage(imageinfo.thumburl, imageinfo.thumbwidth, imageinfo.thumbheight)) {
        return imageinfo.thumburl;
      }
    }
    return null;
  } catch (e) { return null; }
}

// Detect category keywords in place name to improve Wikipedia search
// Normalize accents for search fallback
function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function buildWikiQueries(name, city, country) {
  const lower = name.toLowerCase();
  const location = [city, country].filter(Boolean).join(', ');
  const queries = [];

  const categoryMap = {
    'mus': 'museum',
    'château': 'castle', 'chateau': 'castle',
    'castle': 'castle',
    'abbaye': 'abbey', 'abbey': 'abbey',
    'cathédrale': 'cathedral', 'cathedrale': 'cathedral', 'cathedral': 'cathedral',
    'église': 'church', 'eglise': 'church', 'church': 'church',
    'jardin': 'garden', 'garden': 'garden',
    'parc': 'park', 'park': 'park',
    'fort': 'fortification',
    'citadelle': 'citadel',
    'palais': 'palace', 'palace': 'palace',
    'tour': 'tower', 'tower': 'tower',
  };

  const lowerStripped = stripAccents(lower);
  let categoryHint = '';
  for (const [key, val] of Object.entries(categoryMap)) {
    if (lowerStripped.includes(key)) { categoryHint = val; break; }
  }

  // 1. Full name + full location (most specific)
  queries.push(name + ' ' + location);
  // 2. Full name + city only
  if (city) queries.push(name + ' ' + city);
  // 3. Name alone
  queries.push(name);
  // 4. Accent-stripped name + location (helps with Wikipedia search for French names)
  const nameStripped = stripAccents(name);
  if (nameStripped !== name) {
    queries.push(nameStripped + ' ' + location);
    queries.push(nameStripped);
  }
  // 5. Disambiguate person-named places by prepending category
  if (categoryHint && (lower.includes(' de ') || lower.includes(' di ') || lower.includes(' von '))) {
    queries.unshift(name + ' ' + categoryHint + ' ' + location);
    queries.unshift(name + ' ' + categoryHint);
  }

  // Deduplicate while preserving order
  return queries.filter(function(q, i, arr) { return arr.indexOf(q) === i; });
}

async function getWikimediaImage(name, city, country) {
  const queries = buildWikiQueries(name, city, country);
  const langs = detectWikiLangs(city, country);
  for (let i = 0; i < langs.length; i++) {
    for (let j = 0; j < queries.length; j++) {
      const result = await searchWikiLang(langs[i], queries[j]);
      if (result) return result;
    }
  }
  return null;
}

// Categories where Unsplash returns generic shots instead of specific places
// For these, we trust Wikimedia only
const UNSPLASH_BLOCKLIST_CATEGORIES = [
  'mus', 'museum', 'musée', 'museo', 'museu',  // museums always get generic shots
  'galerie', 'gallery', 'galleria',
  'louvre', 'orsay', 'pompidou',  // famous Paris museums used as generic shots
];

function isUnsplashSafe(name) {
  const lower = name.toLowerCase();
  return !UNSPLASH_BLOCKLIST_CATEGORIES.some(function(cat) {
    return lower.startsWith(cat) || lower.includes(' ' + cat);
  });
}

// Single fast Wikipedia pageimages lookup by exact title
async function getPageImage(title, lang) {
  try {
    const res = await fetch(
      'https://' + lang + '.wikipedia.org/w/api.php?action=query' +
      '&titles=' + encodeURIComponent(title) +
      '&prop=pageimages&piprop=original|thumbnail&pithumbsize=1000' +
      '&format=json&origin=*'
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pages = (data.query && data.query.pages) || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing) return null;
    const src = (page.original && page.original.source) || (page.thumbnail && page.thumbnail.source);
    const w = (page.original && page.original.width) || (page.thumbnail && page.thumbnail.width);
    const h = (page.original && page.original.height) || (page.thumbnail && page.thumbnail.height);
    return isGoodPlaceImage(src, w, h) ? src : null;
  } catch (e) { console.log('[PAGE] error:', e.message); return null; }
}

// Find best Wikipedia article title for a place name
async function findWikipediaTitle(name, city, country) {
  const langs = detectWikiLangs(city, country);
  const queries = [name, name + ' ' + city, stripAccents(name)];

  for (let li = 0; li < langs.length; li++) {
    const lang = langs[li];
    for (let qi = 0; qi < queries.length; qi++) {
      try {
        const res = await fetch(
          'https://' + lang + '.wikipedia.org/w/api.php?action=query&list=search' +
          '&srsearch=' + encodeURIComponent(queries[qi]) +
          '&format=json&origin=*&srnamespace=0&srlimit=3'
        );
        if (!res.ok) continue;
        const data = await res.json();
        const hits = (data.query && data.query.search) || [];
        // Find first hit that looks like our place (not disambiguation, not a person)
        const hit = hits.find(function(h) {
          const t = h.title.toLowerCase();
          return !t.includes('disambiguation') && !t.includes('homonymie') &&
                 !t.includes('list of') && !t.includes('canton') &&
                 !t.includes('arrondissement');
        });
        if (hit) return { title: hit.title, lang: lang };
      } catch (e) { continue; }
    }
  }
  return null;
}

async function findImage(name, city, country) {
  country = country || '';
  console.log('[A] findImage called for:', name);

  const found = await findWikipediaTitle(name, city, country);
  console.log('[A] title:', found ? found.lang+':'+found.title : 'none');
  if (found) {
    const img = await getPageImage(found.title, found.lang);
    if (img) return img;
  }

  if (!isUnsplashSafe(name)) return null;
  const words = name.trim().split(' ').filter(function(w) { return w.length > 2; });
  if (words.length >= 2) {
    return await getUnsplashImage(name + ' ' + city, 'architecture landmark historic');
  }
  return null;
}

// ── PROMPT v3 ─────────────────────────────────────────────────────────────────
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
    + 'A) Specific attraction or landmark (Eiffel Tower, Louvre, Colosseum) → suggest a hidden alternative of the SAME TYPE within 20km maximum\n'
    + 'B) City or town → suggest a lesser-known CITY or TOWN with similar character, same region (NOT a spot within the same city)\n'
    + 'C) Region or country → suggest a lesser-known region with similar character, same country\n\n'
    + 'STEP 3 — SUGGEST AN ALTERNATIVE\n\n'
    + 'GEOGRAPHY — NON-NEGOTIABLE:\n'
    + '- The alternative MUST be in the same country as the input.\n'
    + '- Type A: maximum 20km from the original. Never suggest something in another département, county, or province.\n'
    + '- Type B/C: same region or adjacent region, strictly same country.\n'
    + '- Example: if input is "Rochefort" (France, Charente-Maritime, near La Rochelle), ONLY suggest places in Charente-Maritime or immediately adjacent.\n\n'
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
    + '- Must NOT appear on mainstream top-10 lists or Lonely Planet highlights.\n'
    + '- Local secret preferred: a place locals know but tourists have not yet discovered.\n\n'
    + langInstruction + '\n\n'
    + 'Respond ONLY with valid JSON, no markdown, no backticks:\n'
    + '{\n'
    + '  "name": "Place name",\n'
    + '  "city": "City or nearest town",\n'
    + '  "country": "Country name in English",\n'
    + '  "why": "2-3 sentences explaining why this is a great hidden alternative and what makes it genuinely special",\n'
    + '  "google": "https://www.google.com/search?q=PLACE+CITY+COUNTRY"\n'
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

    parsed.image = await findImage(parsed.name, parsed.city, parsed.country || '');

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
