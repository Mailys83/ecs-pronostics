const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE  = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const AT_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;

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

async function fetchAll() {
  let all = [], offset = null;
  do {
    const url = AT_URL + '?pageSize=100' + (offset ? '&offset=' + offset : '');
    const data = await airtableFetch(url);
    all = [...all, ...(data.records || [])];
    offset = data.offset || null;
  } while (offset);
  return all;
}

function calcPoints(scoreH, scoreA, realH, realA, buteur, buteurs) {
  let pts = 0;
  const pIssue = scoreH > scoreA ? 'V' : scoreH === scoreA ? 'N' : 'D';
  const rIssue = realH  > realA  ? 'V' : realH  === realA  ? 'N' : 'D';

  // 1 pt bonne issue
  if (pIssue === rIssue) pts += 1;

  // 5 pts score exact complet
  if (scoreH === realH && scoreA === realA) {
    pts += 5;
  } else {
    // 2 pts score exact d'une équipe
    if (scoreH === realH) pts += 2;
    if (scoreA === realA) pts += 2;
  }

  // +2 pts buteur bonus
  if (buteur && buteurs && buteurs.length > 0) {
    const b = buteur.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const match = buteurs.some(x => {
      const bx = x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      // Vérifie si un des mots du buteur nommé correspond à un buteur réel
      return b.split(/\s+/).some(word => word.length > 2 && bx.includes(word)) ||
             bx.split(/\s+/).some(word => word.length > 2 && b.includes(word));
    });
    if (match) pts += 2;
  }

  return pts;
}

function buildRanking(records) {
  const totals = {};
  records.forEach(r => {
    const f = r.fields;
    const n = f.nom || '?';
    if (!totals[n]) totals[n] = { name: n, total: 0, matches: {} };
    totals[n].matches[f.match] = {
      sh: f.score_france,
      sa: f.score_adversaire,
      pts: f.points || 0,
      buteur: f.buteur_bonus || ''
    };
    totals[n].total += (f.points || 0);
  });
  return Object.values(totals).sort((a, b) => b.total - a.total);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {

    // ── POST : enregistrer un pronostic (ou import bulk)
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body);

      if (body.bulk) {
        // Import bulk depuis PDF — on stocke les pronostics SANS points (0)
        // Les points seront calculés par PATCH après saisie des résultats
        const records = body.records.map(r => ({
          fields: {
            nom: r.nom,
            match: r.match,
            score_france: r.score_france,
            score_adversaire: r.score_adversaire,
            buteur_bonus: r.buteur_bonus || '',
            points: 0  // toujours 0 à l'import
          }
        }));
        for (let i = 0; i < records.length; i += 10) {
          await airtableFetch(AT_URL, {
            method: 'POST',
            body: JSON.stringify({ records: records.slice(i, i + 10) })
          });
        }
        return { statusCode: 200, headers, body: JSON.stringify({ imported: records.length }) };
      }

      // Pronostic individuel
      const data = await airtableFetch(AT_URL, {
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

    // ── GET : classement
    if (event.httpMethod === 'GET') {
      const all = await fetchAll();
      const action = event.queryStringParameters?.action;
      if (action === 'ranking') {
        const sorted = buildRanking(all);
        return { statusCode: 200, headers, body: JSON.stringify(sorted) };
      }
      return { statusCode: 200, headers, body: JSON.stringify(all) };
    }

    // ── PATCH : calculer les points selon résultats réels
    if (event.httpMethod === 'PATCH') {
      const { results } = JSON.parse(event.body);
      // results = { "Match 1 - FRA/SEN": { h:3, a:1, buteurs:["Mbappé","Barcola"] }, ... }

      if (!results || !Object.keys(results).length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Aucun résultat fourni' }) };
      }

      const all = await fetchAll();
      const updates = [];

      all.forEach(r => {
        const f = r.fields;
        const res = results[f.match];
        if (!res) return; // match sans résultat saisi → on ne touche pas aux points

        const pts = calcPoints(
          f.score_france,
          f.score_adversaire,
          res.h,
          res.a,
          f.buteur_bonus,
          res.buteurs || []
        );
        updates.push({ id: r.id, fields: { points: pts } });
      });

      // Mise à jour par batch de 10
      for (let i = 0; i < updates.length; i += 10) {
        const batch = updates.slice(i, i + 10);
        await airtableFetch(AT_URL, {
          method: 'PATCH',
          body: JSON.stringify({ records: batch.map(u => ({ id: u.id, fields: u.fields })) })
        });
      }

      // Retourner le classement mis à jour
      const updated = await fetchAll();
      const ranking = buildRanking(updated);
      return { statusCode: 200, headers, body: JSON.stringify({ updated: updates.length, ranking }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
