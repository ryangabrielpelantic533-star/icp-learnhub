// ICP LearnHub AI backend (Vercel serverless function).
// Sends the page's questions to Google's Gemini API. The API key stays here on the server.
const buckets = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 40; // per visitor, per 10 minutes
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function tooMany(ip) {
  const now = Date.now();
  const list = (buckets.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  buckets.set(ip, list);
  if (buckets.size > 5000) buckets.clear();
  return list.length > MAX_REQUESTS;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = (process.env.GEMINI_API_KEY || '').replace(/[^\x21-\x7E]/g, '');
  if (!key) return res.status(500).json({ error: 'The server is missing GEMINI_API_KEY.' });

  const allowed = process.env.ALLOWED_ORIGIN; // optional, e.g. https://your-site.vercel.app
  if (allowed && req.headers.origin && req.headers.origin !== allowed) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many requests.' });

  const body = req.body || {};
  let msgs = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  let total = 0;
  msgs = msgs.map(m => {
    const text = String((m && m.content) || '').slice(0, 20000);
    total += text.length;
    return { role: m && m.role === 'assistant' ? 'assistant' : 'user', content: text };
  });
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user' || total > 40000) {
    return res.status(400).json({ error: 'Bad request.' });
  }

  const contents = msgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const images = (Array.isArray(body.images) ? body.images : [])
    .slice(0, 3)
    .filter(i => i && IMAGE_TYPES.includes(i.type) && typeof i.data === 'string' && i.data.length < 2000000);
  if (images.length) {
    const last = contents[contents.length - 1];
    last.parts = [...images.map(i => ({ inline_data: { mime_type: i.type, data: i.data } })), ...last.parts];
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 4096 } })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'Gemini API error.' });
    const cand = (j.candidates || [])[0] || {};
    const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
    if (!text) return res.status(502).json({ error: 'The AI returned no answer. Try rephrasing.' });
    return res.status(200).json({ text, truncated: cand.finishReason === 'MAX_TOKENS' });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Gemini: ' + String((e && (e.cause && e.cause.message || e.message)) || e).slice(0, 200) });
  }
};
