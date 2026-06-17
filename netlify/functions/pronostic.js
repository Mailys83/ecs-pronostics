const AIRTABLE_TOKEN  = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE   = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE  = process.env.AIRTABLE_TABLE;          // pronostics
const AIRTABLE_RESULTS = process.env.AIRTABLE_RESULTS;       // resultats

const AT_PRONOS  = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
const AT_RESULTS = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_RESULTS}`;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Content-Type': 'application/json'
};

async function airtableFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Airtable error');
  return data;
}

async function fetchAll(url) {
  let all = [], offset = null;
  do {
    const u = url + '?pageSize=100' + (offset ? '&offset=' + offset : '');
    const data = await airtableFetch(u);
    all = [...all, ...(data.records || [])];
    offset = data.offset || null;
  } while (offset);
  return all;
}

function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function calcPoints(scoreH, scoreA, realH, realA, buteur, buteurs) {
  let pts = 0;
  const pIssue = scoreH > scoreA ? 'V' : scoreH === scoreA ? 'N' : 'D';
  const rIssue = realH  > realA  ? 'V' : realH  === realA  ? 'N' : 'D';

  // 1 pt bonne issue — toujours indépendant
  if (pIssue === rIssue) pts += 1;

  // 5 pts score exact complet (les deux équipes)
  if (scoreH === realH && scoreA === realA) {
    pts += 5;
  } else {
    // 2 pts par équipe exacte (si score complet raté)
    if (scoreH === realH) pts += 2;
    if (scoreA === realA) pts += 2;
  }

  // +2 pts buteur bonus confirmé
  if (buteur && buteurs && buteurs.length > 0) {
    const b = normalize(buteur);
    const matched = buteurs.some(x => {
      const bx = normalize(x);
      const bWords  = b.split(/[\s,]+/).filter(w => w.length > 2);
      const bxWords = bx.split(/[\s,]+/).filter(w => w.length > 2);
      return bWords.some(w => bxWords.some(wx => wx.includes(w) || w.includes(wx)));
    });
    if (matched) pts += 2;
  }

  return pts;
}

function buildRanking(records, playedMatches) {
  // playedMatches = liste des labels de matchs dont le résultat a été saisi
  const totals = {};
  records.forEach(r => {
    const f = r.fields;
    const n = f.nom || '?';
    if (!totals[n]) totals[n] = { name: n, total: 0, matches: {} };
    const pts = playedMatches && playedMatches.length > 0
      ? (playedMatches.includes(f.match) ? (f.points || 0) : 0)
      : (f.points || 0);
    totals[n].matches[f.match] = {
      sh: f.score_france,
      sa: f.score_adversaire,
      pts: pts,
      buteur: f.buteur_bonus || ''
    };
    totals[n].total += pts;
  });
  return Object.values(totals).sort((a, b) => b.total - a.total);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {

    // ── GET : classement ou résultats sauvegardés
    if (event.httpMethod === 'GET') {
      const action = event.queryStringParameters?.action;

      if (action === 'ranking') {
        const all = await fetchAll(AT_PRONOS);
        // Récupérer les matchs dont le résultat a été saisi
        const resultRecords = await fetchAll(AT_RESULTS);
        const playedMatches = resultRecords.map(r => r.fields.match).filter(Boolean);
        return { statusCode: 200, headers, body: JSON.stringify(buildRanking(all, playedMatches)) };
      }

      if (action === 'results') {
        // Récupère les résultats sauvegardés pour les afficher dans l'Admin
        const all = await fetchAll(AT_RESULTS);
        const results = {};
        all.forEach(r => {
          const f = r.fields;
          if (f.match) results[f.match] = {
            h: f.score_france,
            a: f.score_adversaire,
            buteurs: (f.buteurs || '').split(',').map(s => s.trim()).filter(Boolean),
            recordId: r.id
          };
        });
        return { statusCode: 200, headers, body: JSON.stringify(results) };
      }

      const all = await fetchAll(AT_PRONOS);
      return { statusCode: 200, headers, body: JSON.stringify(all) };
    }

    // ── POST : enregistrer un pronostic
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body);
      const data = await airtableFetch(AT_PRONOS, {
        method: 'POST',
        body: JSON.stringify({ records: [{ fields: {
          nom: body.nom,
          match: body.match,
          score_france: body.score_france,
          score_adversaire: body.score_adversaire,
          buteur_bonus: body.buteur_bonus || '',
          points: 0
        }}]})
      });
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── PATCH : sauvegarder résultats + calculer points
    if (event.httpMethod === 'PATCH') {
      const { results } = JSON.parse(event.body);
      if (!results || !Object.keys(results).length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Aucun résultat fourni' }) };
      }

      // 1. Récupérer les résultats déjà sauvegardés
      const existingRecords = await fetchAll(AT_RESULTS);
      const existingByMatch = {};
      existingRecords.forEach(r => { existingByMatch[r.fields.match] = r.id; });

      // 2. Sauvegarder/mettre à jour chaque résultat dans la table resultats
      for (const [matchLabel, res] of Object.entries(results)) {
        const fields = {
          match: matchLabel,
          score_france: res.h,
          score_adversaire: res.a,
          buteurs: res.buteurs.join(', ')
        };
        if (existingByMatch[matchLabel]) {
          // Mise à jour
          await airtableFetch(AT_RESULTS, {
            method: 'PATCH',
            body: JSON.stringify({ records: [{ id: existingByMatch[matchLabel], fields }] })
          });
        } else {
          // Création
          await airtableFetch(AT_RESULTS, {
            method: 'POST',
            body: JSON.stringify({ records: [{ fields }] })
          });
        }
      }

      // 3. Récupérer TOUS les résultats sauvegardés (pas seulement ceux envoyés maintenant)
      const allResultRecords = await fetchAll(AT_RESULTS);
      const allResults = {};
      allResultRecords.forEach(r => {
        const f = r.fields;
        if (f.match) allResults[f.match] = {
          h: f.score_france,
          a: f.score_adversaire,
          buteurs: (f.buteurs || '').split(',').map(s => s.trim()).filter(Boolean)
        };
      });

      // 4. Calculer les points pour TOUS les pronostics :
      //    - match avec résultat → calcul normal
      //    - match sans résultat → 0 points (remet à zéro les anciens calculs erronés)
      const allPronos = await fetchAll(AT_PRONOS);
      const updates = [];
      allPronos.forEach(r => {
        const f = r.fields;
        const res = allResults[f.match];
        const pts = res ? calcPoints(
          f.score_france, f.score_adversaire,
          res.h, res.a,
          f.buteur_bonus, res.buteurs || []
        ) : 0; // pas de résultat = 0 point
        updates.push({ id: r.id, fields: { points: pts } });
      });

      for (let i = 0; i < updates.length; i += 10) {
        const batch = updates.slice(i, i + 10);
        await airtableFetch(AT_PRONOS, {
          method: 'PATCH',
          body: JSON.stringify({ records: batch.map(u => ({ id: u.id, fields: u.fields })) })
        });
      }

      const updated = await fetchAll(AT_PRONOS);
      const allResultRecordsAfter = await fetchAll(AT_RESULTS);
      const playedMatchesAfter = allResultRecordsAfter.map(r => r.fields.match).filter(Boolean);
      return { statusCode: 200, headers, body: JSON.stringify({
        updated: updates.length,
        ranking: buildRanking(updated, playedMatchesAfter)
      })};
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
