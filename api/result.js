// Fonction serverless Vercel : POST /api/result  { "email": "..." }
// Les données restent côté serveur ; seul le résultat du participant est renvoyé.
const data = require('../data/results.json');

// Limitation de débit basique (en mémoire, par instance) : 8 requêtes / minute / IP
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 8;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans une minute.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Saisis une adresse email valide.' });
  }

  // Petit délai constant pour limiter l'énumération par chronométrage
  await new Promise(r => setTimeout(r, 300));

  const rec = Object.prototype.hasOwnProperty.call(data, email) ? data[email] : null;
  if (!rec) {
    return res.status(404).json({
      error: "Aucun résultat trouvé pour cette adresse. Vérifie l'orthographe ou utilise l'email de ton inscription.",
    });
  }
  return res.status(200).json(rec);
};
