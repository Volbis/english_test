# Résultats du test d'anglais

## Mettre à jour les données
1. Dans Google Sheets : Fichier → Télécharger → Page Web (.html), et place `Sheet1.html` dans `data/` (ou un export TSV/CSV).
   La base brute reste locale : elle est exclue du déploiement (.vercelignore).
2. `node scripts/build-data.mjs data/Sheet1.html data/session2.csv` → génère `data/results.json` (toutes les sessions cumulées ; un fichier par session, la session 1 en premier). Un export brut sans en-tête (20 colonnes, comme `session2.csv`) est reconnu automatiquement.
3. Redéploie.

## Règles appliquées (100 % des personnes ont un résultat)
- **Sections passées** : Reading > 0, Structure > 1,3 (1/24 = valeur enregistrée quand la section n'est pas faite), Writing noté.
- **Notes de Writing** : `data/writing-grades.json` (113 textes notés /30 par Claude, modifiables). Une note saisie dans la colonne Writing /30 de la feuille est prioritaire.
- **Plusieurs emails pour une même personne** : regroupés automatiquement si le nom est identique (ordre libre), ou via `data/fusions.json` si le nom diffère. Tous les emails renvoient le même résultat (meilleure note par section) et le même nom.
- **Section manquante** : estimée par régression à partir des sections faites (calibrée sur les personnes complètes de la session 1, pour qu'une nouvelle session ne modifie pas les estimations déjà publiées) et marquée « estimé ».
- **Personne qui repasse le test** (même nom ou même email dans une autre session) : meilleure note par section, toutes sessions confondues.
- **Score final /100** = (Reading + Structure + Writing) / 90 × 100. **Niveau** : < 50 Débutant · 50–79,9 Intermédiaire · ≥ 80 Avancé.
- **Niveaux forcés** : `data/niveaux-forces.json` (email → niveau) prime sur le calcul, pour tous les emails de la personne. Le score affiché n'est pas modifié.
- **Exclus** : même calcul, avec la mention « Session interrompue » et le motif.
- **Aucune réponse** : niveau Débutant (niveau de départ).
- Jamais exposés : infractions, durée, détail brut, nombre de mots, texte du Writing.

## Déployer sur Vercel
- CLI : `npm i -g vercel && vercel login && vercel --prod` (depuis ce dossier)
- ou : pousse sur GitHub puis « Import Project » sur vercel.com (aucun réglage, aucun build).
