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

function buildRanking(records) {
  const totals = {};
  records.forEach(r => {
    const f = r.fields;
    const n = f.nom || '?';
    if (!totals[n]) totals[n] = { name: n, total: 0, matches: {} };
    totals[n].matches[f.match] = { sh: f.score_france, sa: f.score_adversaire, pts: f.points || 0, buteur: f.buteur_bonus || '' };
    totals[n].total += (f.points || 0);
  });
  return Object.values(totals).sort((a, b) => b.total - a.total);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body);

      // Import bulk (depuis PDF)
      if (body.bulk) {
        const records = body.records.map(r => ({ fields: r }));
        // Airtable accepte max 10 records par requête
        for (let i = 0; i < records.length; i += 10) {
          const batch = records.slice(i, i + 10);
          await airtableFetch(AT_URL, {
            method: 'POST',
            body: JSON.stringify({ records: batch })
          });
        }
        return { statusCode: 200, headers, body: JSON.stringify({ imported: records.length }) };
      }

      const data = await airtableFetch(AT_URL, {
        method: 'POST',
        body: JSON.stringify({ records: [{ fields: body }] })
      });
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (event.httpMethod === 'GET') {
      const action = event.queryStringParameters?.action;
      const all = await fetchAll();

      if (action === 'ranking') {
        const sorted = buildRanking(all);
        return { statusCode: 200, headers, body: JSON.stringify(sorted) };
      }

      return { statusCode: 200, headers, body: JSON.stringify(all) };
    }

    if (event.httpMethod === 'PATCH') {
      const { results } = JSON.parse(event.body);
      const all = await fetchAll();
      const updates = [];

      all.forEach(r => {
        const f = r.fields;
        const res = results[f.match];
        if (!res) return;
        let pts = 0;
        const pIssue = f.score_france > f.score_adversaire ? 'V' : f.score_france === f.score_adversaire ? 'N' : 'D';
        if (pIssue === res.issue) pts += 1;
        if (f.score_france === res.h && f.score_adversaire === res.a) pts += 5;
        else { if (f.score_france === res.h) pts += 2; if (f.score_adversaire === res.a) pts += 2; }
        // Buteur bonus
        if (f.buteur_bonus && res.buteurs && res.buteurs.length) {
          const b = f.buteur_bonus.toLowerCase();
          if (res.buteurs.some(x => b.includes(x.toLowerCase()))) pts += 2;
        }
        updates.push({ id: r.id, fields: { points: pts } });
      });

      for (let i = 0; i < updates.length; i += 10) {
        const batch = updates.slice(i, i + 10);
        await airtableFetch(AT_URL, {
          method: 'PATCH',
          body: JSON.stringify({ records: batch.map(u => ({ id: u.id, fields: u.fields })) })
        });
      }

      const updated = await fetchAll();
      const ranking = buildRanking(updated);
      return { statusCode: 200, headers, body: JSON.stringify({ updated: updates.length, ranking }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
