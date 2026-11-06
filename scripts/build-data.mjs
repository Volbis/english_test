// Construit data/results.json à partir de la base de résultats.
// Usage : node scripts/build-data.mjs data/Sheet1.html   (export Google Sheets « Page Web »)
//         node scripts/build-data.mjs export.tsv         (TSV/CSV avec en-tête)
//
// Principe : chaque personne reçoit un résultat final, sans exception.
//  1. Sections réellement passées : Reading > 0, Structure > 1,3 (1/24 = valeur plancher d'une section non faite),
//     Writing noté (colonne Writing /30, sinon Writing /10 × 3, sinon data/writing-grades.json).
//  2. Une même personne inscrite sous plusieurs emails : ses passages sont fusionnés (meilleure note par section).
//  3. Section manquante : estimée par régression linéaire à partir des sections passées, calibrée sur les
//     personnes ayant passé les trois sections.
//  4. Score final /100 = (Reading + Structure + Writing) / 90 × 100 ; niveau : < 50 Débutant · 50–79,9 Intermédiaire · ≥ 80 Avancé.
//
// Ne sortent jamais d'ici : infractions, durée, détail brut, nombre de mots, texte du Writing.
import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2] || 'data/Sheet1.html';
if (!fs.existsSync(input)) {
  console.error(`Fichier introuvable : ${input}\nUsage : node scripts/build-data.mjs data/Sheet1.html`);
  process.exit(1);
}
const raw = fs.readFileSync(input, 'utf8').replace(/^﻿/, '');
const isHtml = /\.html?$/i.test(input) || /^\s*<(!doctype|html|meta|table|style)/i.test(raw);

/* ---------- Lecture ---------- */
function decode(s) {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
}
function parseHtml(html) {
  const out = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    out.push((tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(c => decode(c.replace(/^<t[dh][^>]*>|<\/t[dh]>$/gi, ''))));
  }
  // Google Sheets ajoute une ligne de lettres (A, B, C…) et une colonne de numéros de ligne
  if (out.length && out[0][0].trim() === '' && out[0].slice(1, 4).join('') === 'ABC') {
    out.shift();
    for (const r of out) r.shift();
  }
  return out.filter(r => r.some(x => x.trim() !== ''));
}
function parseDelimited(text) {
  const first = text.split(/\r?\n/)[0];
  const d = ['\t', ';', ','].map(x => [x, first.split(x).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

const rows = isHtml ? parseHtml(raw) : parseDelimited(raw);
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9/ ]/g, '').trim();
const H = rows.shift().map(norm);
const find = pred => H.findIndex(pred);
const idx = {
  nom: find(h => h === 'nom'),
  email: find(h => h === 'email'),
  statut: find(h => h === 'statut'),
  reading: find(h => h.startsWith('reading')),
  structure: find(h => h.startsWith('structure')),
  writing30: find(h => h.startsWith('writing') && h.includes('/30')),
  writing10: find(h => h.startsWith('writing') && h.includes('/10')),
  mots: find(h => h === 'mots'),
  correction: find(h => h === 'correction' || h.startsWith('commentaire')),
};
const missing = ['nom', 'email', 'reading', 'structure'].filter(k => idx[k] < 0);
if (missing.length) {
  console.error('Colonnes introuvables : ' + missing.join(', ') + '\nEn-têtes lus : ' + H.join(' | '));
  process.exit(1);
}
const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
const num = v => {
  if (v === '') return null;
  const n = parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Notes de Writing attribuées hors feuille (clé : email)
const gradesFile = path.join(path.dirname(input), 'writing-grades.json');
const grades = fs.existsSync(gradesFile) ? (JSON.parse(fs.readFileSync(gradesFile, 'utf8')).notes || {}) : {};

/* ---------- Passages ---------- */
const EXCLUSION = [
  [/focus lost/i, 'Sortie de la fenêtre du test (autre fenêtre, application ou zone du navigateur).'],
  [/full-?screen/i, 'Sortie du mode plein écran.'],
  [/left the test tab/i, "Sortie de l'onglet du test."],
];
const STATE_WORD = /^(PROVISOIRE|D[EÉ]FINITIF|FINAL|VALID[EÉ]|EN COURS)$/i;
const PLANCHER_S = 1.3; // 1/24 : valeur enregistrée quand la section Structure n'a pas été faite

let skipped = 0;
const sansNote = [];
const attempts = [];
for (const r of rows) {
  const email = get(r, 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
  const statut = get(r, 'statut');
  const R = num(get(r, 'reading')), S = num(get(r, 'structure'));
  const mots = num(get(r, 'mots')) || 0;
  let W = num(get(r, 'writing30'));
  if (W === null && num(get(r, 'writing10')) !== null) W = num(get(r, 'writing10')) * 3;
  if (W === null && email in grades) W = grades[email];
  if (W === null && mots > 0) sansNote.push(email);
  const correction = get(r, 'correction');
  attempts.push({
    email, nom: get(r, 'nom').replace(/\s+/g, ' '),
    exclu: /^EXCLU/i.test(statut),
    motif: (EXCLUSION.find(([re]) => re.test(statut)) || [])[1] || null,
    R: R !== null && R > 0 ? R : null,
    S: S !== null && S > PLANCHER_S ? S : null,
    W: W !== null ? Math.max(0, Math.min(30, W)) : null,
    correction: STATE_WORD.test(correction) ? '' : correction,
  });
}

/* ---------- Regroupement par personne (même nom ou même email) ---------- */
const nameKey = n => n.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '').split('').sort().join('');
const parent = attempts.map((_, i) => i);
const root = i => (parent[i] === i ? i : (parent[i] = root(parent[i])));
const firstBy = {};
attempts.forEach((a, i) => {
  const keys = ['e:' + a.email];
  if (nameKey(a.nom)) keys.push('n:' + nameKey(a.nom));
  for (const k of keys) {
    if (k in firstBy) parent[root(i)] = root(firstBy[k]); else firstBy[k] = i;
  }
});
// Fusions manuelles (noms différents d'un compte à l'autre) : data/fusions.json
const fusionsFile = path.join(path.dirname(input), 'fusions.json');
const fusions = fs.existsSync(fusionsFile) ? (JSON.parse(fs.readFileSync(fusionsFile, 'utf8')).groupes || []) : [];
const byEmail = Object.fromEntries(attempts.map((a, i) => [a.email, i]));
const fusionInconnus = [];
for (const g of fusions) {
  const ids = g.map(e => String(e).trim().toLowerCase()).filter(e => (e in byEmail) || !fusionInconnus.push(e)).map(e => byEmail[e]);
  for (const i of ids.slice(1)) parent[root(i)] = root(ids[0]);
}
const groups = {};
attempts.forEach((a, i) => (groups[root(i)] ||= []).push(a));

const maxOf = (list, k) => list.reduce((m, a) => (a[k] !== null && (m === null || a[k] > m) ? a[k] : m), null);
const persons = Object.values(groups).map(list => ({
  list,
  R: maxOf(list, 'R'), S: maxOf(list, 'S'), W: maxOf(list, 'W'),
  exclu: list.every(a => a.exclu),
  motif: [...list].reverse().find(a => a.motif)?.motif || null,
  correction: [...list].reverse().find(a => a.correction)?.correction || '',
}));

/* ---------- Régression : estimer une section à partir des autres ---------- */
const KEYS = ['R', 'S', 'W'];
const complete = persons.filter(p => KEYS.every(k => p[k] !== null));
if (complete.length < 10) {
  console.error(`Trop peu de personnes ayant passé les trois sections (${complete.length}) pour calibrer les estimations.`);
  process.exit(1);
}
function ols(X, y) { // moindres carrés avec constante (petit système, élimination de Gauss-Jordan)
  const A = X.map(r => [1, ...r]), n = A[0].length;
  const M = Array.from({ length: n }, (_, i) => [
    ...Array.from({ length: n }, (_, j) => A.reduce((s, r) => s + r[i] * r[j], 0)),
    A.reduce((s, r, k) => s + r[i] * y[k], 0),
  ]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
const models = {};
for (const target of KEYS) {
  const others = KEYS.filter(k => k !== target);
  for (const preds of [others, ...others.map(k => [k])]) {
    models[target + '|' + preds.join('')] = { preds, coef: ols(complete.map(p => preds.map(k => p[k])), complete.map(p => p[target])) };
  }
}
const clamp = v => Math.max(0, Math.min(30, v));
const predict = (target, p) => {
  const preds = KEYS.filter(k => k !== target && p[k] !== null);
  if (!preds.length) return null;
  const m = models[target + '|' + preds.join('')];
  return clamp(m.coef[0] + m.preds.reduce((s, k, i) => s + m.coef[i + 1] * p[k], 0));
};

// Contrôle de fiabilité : on masque chaque section d'une personne complète et on mesure l'écart
const err = {};
for (const k of KEYS) {
  const e = complete.map(p => Math.abs(predict(k, { ...p, [k]: null }) - p[k]));
  err[k] = e.reduce((a, b) => a + b, 0) / e.length;
}

/* ---------- Résultat final ---------- */
const LABEL = { R: ['reading', 'Reading'], S: ['structure', 'Structure'], W: ['writing', 'Writing'] };
const niveau = sc => (sc >= 80 ? 'Avancé' : sc >= 50 ? 'Intermédiaire' : 'Débutant');
const round1 = v => Math.round(v * 10) / 10;
const stats = { complet: 0, estime: 0, defaut: 0, fusions: 0, exclus: 0 };
const out = {};

for (const p of persons) {
  const taken = KEYS.filter(k => p[k] !== null);
  let base = 'defaut', sections = [];
  if (taken.length) {
    base = taken.length === 3 ? 'complet' : 'estime';
    sections = KEYS.map(k => {
      const estime = p[k] === null;
      return { key: LABEL[k][0], label: LABEL[k][1], score: round1(estime ? predict(k, p) : p[k]), max: 30, ...(estime && { estime: true }) };
    });
  }
  // Aucune réponse exploitable : niveau de départ (Débutant), score 0
  const score = sections.length ? round1(sections.reduce((s, x) => s + x.score, 0) / 90 * 100) : 0;
  stats[base]++;
  if (p.list.length > 1) stats.fusions++;
  if (p.exclu) stats.exclus++;

  const rec = { score, niveau: niveau(score), base, sections };
  if (p.list.length > 1) rec.passages = p.list.length;
  if (p.exclu) { rec.exclu = true; rec.motif = p.motif; }
  if (p.correction) rec.correction = p.correction;
  // Même nom affiché quel que soit l'email : la forme la plus complète
  const nom = p.list.map(a => a.nom).sort((x, y) => y.split(' ').length - x.split(' ').length || y.length - x.length)[0];
  for (const a of p.list) out[a.email] = { nom, ...rec };
}

fs.mkdirSync('data', { recursive: true });
// Un participant par ligne, triés par nom puis email (lisible de haut en bas)
const sortKey = e => out[e].nom.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + ' ' + e;
const lines = Object.keys(out).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  .map(e => `  ${JSON.stringify(e)}: ${JSON.stringify(out[e])}`);
fs.writeFileSync(path.join('data', 'results.json'), '{\n' + lines.join(',\n') + '\n}\n');

const dist = {};
for (const p of persons) { const n = out[p.list[0].email].niveau; dist[n] = (dist[n] || 0) + 1; }
console.log(`✓ ${Object.keys(out).length} emails · ${persons.length} personnes · 100 % avec un résultat (${skipped} ligne(s) sans email valide ignorée(s)).`);
console.log(`  Bases : ${stats.complet} complètes, ${stats.estime} avec section(s) estimée(s), ${stats.defaut} sans aucune réponse (Débutant).`);
console.log(`  ${stats.fusions} personne(s) inscrite(s) sous plusieurs emails fusionnée(s) · ${stats.exclus} exclue(s) avec résultat attribué.`);
console.log(`  Régression calibrée sur ${complete.length} personnes complètes · écart moyen d'estimation (sur 30) : Reading ±${err.R.toFixed(1)}, Structure ±${err.S.toFixed(1)}, Writing ±${err.W.toFixed(1)}.`);
console.log(`  Niveaux (par personne) : ${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
if (fusionInconnus.length) console.warn(`⚠ fusions.json : email(s) absent(s) de la base : ${fusionInconnus.join(', ')}`);
if (sansNote.length) console.warn(`⚠ ${sansNote.length} Writing rendu(s) sans note (à ajouter dans writing-grades.json) : ${sansNote.slice(0, 5).join(', ')}`);
