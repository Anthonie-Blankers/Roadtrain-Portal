const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express(); app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const SESSIE_GEHEIM = process.env.SESSIE_GEHEIM || 'dev-geheim-verander-mij';
const ADMIN_WACHTWOORD = process.env.ADMIN_WACHTWOORD || 'wijzig-mij';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const LANDEN = [
  ['NL', 'Nederland'], ['BE', 'Belgie'], ['DE', 'Duitsland'], ['FR', 'Frankrijk'],
  ['LU', 'Luxemburg'], ['GB', 'Verenigd Koninkrijk'], ['IE', 'Ierland'],
  ['ES', 'Spanje'], ['PT', 'Portugal'], ['IT', 'Italie'], ['AT', 'Oostenrijk'],
  ['CH', 'Zwitserland'], ['PL', 'Polen'], ['CZ', 'Tsjechie'], ['SK', 'Slowakije'],
  ['HU', 'Hongarije'], ['RO', 'Roemenie'], ['BG', 'Bulgarije'], ['SI', 'Slovenie'],
  ['HR', 'Kroatie'], ['DK', 'Denemarken'], ['SE', 'Zweden'], ['NO', 'Noorwegen'],
  ['FI', 'Finland'], ['GR', 'Griekenland'],
];

function landNaam(code) { const f = LANDEN.find(x => x[0] === code); return f ? f[1] : code; }

// ---------- database migratie ----------
async function migreer() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      naam TEXT NOT NULL,
      code TEXT NOT NULL,
      actief BOOLEAN NOT NULL DEFAULT true,
      aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      type TEXT,
      van_land TEXT, van_postcode TEXT, van_plaats TEXT,
      naar_land TEXT, naar_postcode TEXT, naar_plaats TEXT,
      laaddatum_van TEXT, laaddatum_tot TEXT,
      losdatum_van TEXT, losdatum_tot TEXT,
      laadmeter TEXT, hoogte TEXT, gewicht TEXT,
      type_lading TEXT, opmerking TEXT,
      bedrijf TEXT, contactpersoon TEXT, telefoon TEXT, email TEXT,
      status TEXT DEFAULT 'open',
      geplaatst_op TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS bedrijf_id TEXT`); await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS laadtijd_van TEXT`); await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS laadtijd_tot TEXT`); await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS lostijd_van TEXT`); await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS lostijd_tot TEXT`); await pool.query(`CREATE TABLE IF NOT EXISTS archief (id TEXT PRIMARY KEY, type TEXT, van_land TEXT, van_postcode TEXT, van_plaats TEXT, naar_land TEXT, naar_postcode TEXT, naar_plaats TEXT, laaddatum_van TEXT, laaddatum_tot TEXT, losdatum_van TEXT, losdatum_tot TEXT, laadmeter TEXT, hoogte TEXT, gewicht TEXT, type_lading TEXT, opmerking TEXT, bedrijf TEXT, contactpersoon TEXT, telefoon TEXT, email TEXT, bedrijf_id TEXT, online_sinds TIMESTAMPTZ, offline_sinds TIMESTAMPTZ NOT NULL DEFAULT now())`);
  // koppel bestaande aanbiedingen (zonder eigenaar) op basis van bedrijfsnaam, zodat oude data niet wees wordt
  await pool.query(`
    UPDATE offers o SET bedrijf_id = c.id
    FROM companies c
    WHERE o.bedrijf_id IS NULL AND o.bedrijf = c.naam
  `);
}

// ---------- sessies (ondertekende cookies, geen extra dependencies) ----------
function sign(waarde) {
  return crypto.createHmac('sha256', SESSIE_GEHEIM).update(waarde).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(deel => {
    const idx = deel.indexOf('=');
    if (idx === -1) return;
    const k = deel.slice(0, idx).trim();
    const v = deel.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

async function getIngelogdBedrijf(req) {
  const cookies = parseCookies(req);
  const raw = cookies.sessie;
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx === -1) return null;
  const bedrijfId = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  if (sign(bedrijfId) !== sig) return null;
  const { rows } = await pool.query('SELECT * FROM companies WHERE id = $1 AND actief = true', [bedrijfId]);
  return rows[0] || null;
}

function isAdminIngelogd(req) {
  const cookies = parseCookies(req);
  return cookies.admin_sessie === sign('admin-sessie-marker');
}

// haalt eenmaal per request het ingelogde bedrijf op, zodat layout() en requireLogin dit synchroon kunnen gebruiken
app.use(async (req, res, next) => {
  try {
    req.ingelogdBedrijf = await getIngelogdBedrijf(req);
  } catch (e) {
    req.ingelogdBedrijf = null;
  }
  next();
});

function requireLogin(req, res, next) {
  if (!req.ingelogdBedrijf) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  req.bedrijf = req.ingelogdBedrijf;
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdminIngelogd(req)) {
    return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// vangt fouten in async route-handlers netjes op i.p.v. de server te laten crashen
function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

async function archiveerAanbieding(offer) { await pool.query(`INSERT INTO archief (id, type, van_land, van_postcode, van_plaats, naar_land, naar_postcode, naar_plaats, laaddatum_van, laaddatum_tot, losdatum_van, losdatum_tot, laadmeter, hoogte, gewicht, type_lading, opmerking, bedrijf, contactpersoon, telefoon, email, bedrijf_id, online_sinds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) ON CONFLICT (id) DO NOTHING`, [offer.id, offer.type, offer.van_land, offer.van_postcode, offer.van_plaats, offer.naar_land, offer.naar_postcode, offer.naar_plaats, offer.laaddatum_van, offer.laaddatum_tot, offer.losdatum_van, offer.losdatum_tot, offer.laadmeter, offer.hoogte, offer.gewicht, offer.type_lading, offer.opmerking, offer.bedrijf, offer.contactpersoon, offer.telefoon, offer.email, offer.bedrijf_id, offer.geplaatst_op]); } function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function landOptions(selected, metAlle) {
  let opts = metAlle ? `<option value="alle" ${selected === 'alle' ? 'selected' : ''}>Alle landen</option>` : '';
  opts += LANDEN.map(([code, naam]) =>
    `<option value="${code}" ${selected === code ? 'selected' : ''}>${code} - ${naam}</option>`
  ).join('');
  return opts;
}

// ---------- layout ----------
function layout(req, title, body, opts = {}) {
  const bedrijf = req ? req.ingelogdBedrijf : null;
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title><link rel="icon" href="/icon-white.png">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/css/flag-icons.min.css">
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <a href="/" class="logo"><img src="/logo-header-final.png" alt="CombiMatch &mdash; The Roadtrain Exchange" class="logo-img-wordmark"></a>
    <nav>
      <a href="/">Home</a>
      <a href="/overzicht">Overzicht</a>
      <a href="/nieuw/vracht">Vracht aanbieden</a>
      <a href="/nieuw/capaciteit">Capaciteit aanbieden</a>
      ${bedrijf ? `<a href="/uitloggen">Uitloggen (${esc(bedrijf.naam)})</a>` : `<a href="/login">Inloggen</a>`}
    </nav>
  </div>
</header>
<main class="wrap${opts.wideMain ? ' main-wide' : ''}">
${body}
</main>
<footer class="wrap footer">
  <p>CombiMatch &ndash; The Roadtrain Exchange verbindt vervoerders met (volume)combi's & LZV's van alle types. Via &eacute;&eacute;n platform deel je eenvoudig beschikbare capaciteit, vind je passende vrachten en werk je samen met betrouwbare transportpartners. Zo verhogen we samen de beladingsgraad, beperken we lege kilometers en maken we transport slimmer, duurzamer en rendabeler.</p>
  <p style="margin-top:8px;"><a href="/admin/login" style="color:var(--grijs);font-size:0.75rem;">Beheer</a></p>
</footer>
</body>
</html>`;
}

function locatie(land, postcode, plaats) {
  const bekend = LANDEN.some(x => x[0] === land);
  const landWeergave = land ? (bekend ? '<span class="fi fi-' + land.toLowerCase() + '"></span> ' + esc(landNaam(land)) : esc(land)) : '';
  const rest = [esc(postcode), esc(plaats)].filter(Boolean).join(' ');
  return [landWeergave, rest].filter(Boolean).join(', ') || '-';
}

// ---------- routes ----------

// homepage (publiek toegankelijk)
app.get('/', (req, res) => {
  const body = `
  <div class="hero">
    <img src="/logo-hero.png" alt="CombiMatch - The Roadtrain Exchange" class="hero-logo">
    <p class="hero-tagline">E&eacute;n platform waar vervoerders die met combi's & LZV's rijden vrachten en beschikbare laadcapaciteit met elkaar delen &mdash; minder lege kilometers, een hogere beladingsgraad.</p>
    <div class="hero-actions">
      <a href="/nieuw/vracht" class="btn-hero btn-hero-vracht">
        <span class="btn-hero-title">Vracht aanbieden</span>
        <span class="btn-hero-sub">Ik zoek een combi voor mijn lading</span>
      </a>
      <a href="/nieuw/capaciteit" class="btn-hero btn-hero-capaciteit">
        <span class="btn-hero-title">Capaciteit aanbieden</span>
        <span class="btn-hero-sub">Ik heb een combi vrij</span>
      </a>
    </div>
    <p class="hero-link"><a href="/overzicht">Bekijk alle openstaande aanbiedingen &rarr;</a></p>
  </div>
  `;
  res.send(layout(req, 'CombiMatch - The Roadtrain Exchange', body));
});

// ---------- inloggen (bedrijven) ----------
const inlogPogingen = new Map(); function rateLimitCheck(sleutel) { const nu = Date.now(); const entry = inlogPogingen.get(sleutel); if (entry && entry.until > nu) return Math.ceil((entry.until - nu) / 60000); return 0; } function rateLimitMislukt(sleutel) { const nu = Date.now(); const entry = inlogPogingen.get(sleutel) || { count: 0, until: 0 }; entry.count += 1; if (entry.count >= 5) { entry.until = nu + 15 * 60 * 1000; entry.count = 0; } inlogPogingen.set(sleutel, entry); } function rateLimitReset(sleutel) { inlogPogingen.delete(sleutel); } app.get('/login', (req, res) => {
  const next = req.query.next || '/overzicht';
  const fout = req.query.fout === '1'; const geblokkeerd = req.query.fout === '2';
  const body = `
  <h1>Inloggen</h1>
  <p class="form-intro">Voer de toegangscode van je bedrijf in om aanbiedingen te bekijken en te plaatsen. Geen code? Neem contact op met CombiMatch.</p>
  ${fout ? '<p style="color:#b00020;font-weight:600;">Deze toegangscode is niet geldig. Probeer het opnieuw.</p>' : ''}${geblokkeerd ? '<p style="color:#b00020;font-weight:600;">Te veel mislukte pogingen. Probeer het over 15 minuten opnieuw.</p>' : ''}
  <form class="offer-form" method="post" action="/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <div class="form-row">
      <label>Toegangscode</label>
      <input type="text" name="code" required autofocus placeholder="bijv. AB3D9K" style="text-transform:uppercase;letter-spacing:0.1em;">
    </div>
    <div class="form-row">
      <button type="submit">Inloggen</button>
    </div>
  </form>
  `;
  res.send(layout(req, 'Combi-Match - Inloggen', body));
});

app.post('/login', ah(async (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase();
  const next = req.body.next || '/overzicht'; const rlKey = 'login:' + req.ip; const wachtMin = rateLimitCheck(rlKey); if (wachtMin > 0) { return res.redirect(`/login?fout=2&next=${encodeURIComponent(next)}`); }
  const { rows } = await pool.query(
    'SELECT * FROM companies WHERE actief = true AND UPPER(code) = $1',
    [code]
  );
  const bedrijf = rows[0];
  if (!bedrijf) {
    rateLimitMislukt(rlKey); return res.redirect(`/login?fout=1&next=${encodeURIComponent(next)}`);
  }
  const waarde = `${bedrijf.id}.${sign(bedrijf.id)}`;
  rateLimitReset(rlKey); res.cookie('sessie', waarde, { httpOnly: true, secure: true, maxAge: 1000 * 60 * 60 * 24 * 90, sameSite: 'lax' });
  res.redirect(next);
}));

app.get('/uitloggen', (req, res) => {
  res.clearCookie('sessie');
  res.redirect('/');
});

// overview + filters (login vereist)
app.get('/overzicht', requireLogin, ah(async (req, res) => {
  const { rows: offers } = await pool.query('SELECT * FROM offers');
  offers.sort((a, b) => new Date(b.geplaatst_op) - new Date(a.geplaatst_op));

  const q = req.query;
  const type = q.type || 'alle';
  const vanLand = q.van_land || 'alle';
  const naarLand = q.naar_land || 'alle';
  const vanPcs = [q.van_pc1, q.van_pc2, q.van_pc3].map(v => (v || '').trim().toLowerCase()).filter(Boolean);
  const naarPcs = [q.naar_pc1, q.naar_pc2, q.naar_pc3].map(v => (v || '').trim().toLowerCase()).filter(Boolean);
  const laadVanaf = q.laad_vanaf || '';
  const laadTot = q.laad_tot || '';
  const losVanaf = q.los_vanaf || '';
  const losTot = q.los_tot || '';
  const lmMin = q.lm_min !== undefined && q.lm_min !== '' ? parseFloat(q.lm_min) : 13.65;
  const lmMax = q.lm_max !== undefined && q.lm_max !== '' ? parseFloat(q.lm_max) : 22.0;
  const hMin = q.h_min !== undefined && q.h_min !== '' ? parseFloat(q.h_min) : 0.1;
  const hMax = q.h_max !== undefined && q.h_max !== '' ? parseFloat(q.h_max) : 3.10;
  const toonAfgehandeld = q.toon_afgehandeld === '1';

  function overlapt(startO, eindO, filterVanaf, filterTot) {
    if (!filterVanaf && !filterTot) return true;
    const vanaf = filterVanaf || '0000-01-01';
    const tot = filterTot || '9999-12-31';
    const oVan = startO || '0000-01-01';
    const oTot = eindO || oVan;
    return oVan <= tot && vanaf <= oTot;
  }

  function matchLocatie(land, postcode, filterLand, pcPrefixes) {
    if (filterLand && filterLand !== 'alle' && land !== filterLand) return false;
    if (pcPrefixes.length) {
      const pc = (postcode || '').toLowerCase();
      if (!pcPrefixes.some(p => pc.startsWith(p))) return false;
    }
    return true;
  }

  const filtered = offers.filter(o => {
    if (!toonAfgehandeld && o.status === 'vervuld') return false;
    if (type !== 'alle' && o.type !== type) return false;
    if (!matchLocatie(o.van_land, o.van_postcode, vanLand, vanPcs)) return false;
    if (!matchLocatie(o.naar_land, o.naar_postcode, naarLand, naarPcs)) return false;
    if (!overlapt(o.laaddatum_van, o.laaddatum_tot, laadVanaf, laadTot)) return false;
    if (!overlapt(o.losdatum_van, o.losdatum_tot, losVanaf, losTot)) return false;
    const lm = parseFloat(o.laadmeter);
    if (!isNaN(lm) && (lm < lmMin || lm > lmMax)) return false;
    const h = parseFloat(o.hoogte);
    if (!isNaN(h) && (h < hMin || h > hMax)) return false;
    return true;
  });

  filtered.sort((a, b) => new Date(a.laaddatum_van) - new Date(b.laaddatum_van));

  function periode(van_, tot_) {
    const fmt = d => { const p = (d||'').split('-'); return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : (d||''); }; if (!van_) return '-';
    if (!tot_ || tot_ === van_) return esc(fmt(van_));
    return `${esc(fmt(van_))}<br>&ndash; ${esc(fmt(tot_))}`;
  }

  function mailtoBody(o) { const regels = [`Geachte ${o.contactpersoon || ''},`, '', 'Is deze aanbieding nog actueel?', '', `Route: ${o.van_land} ${o.van_postcode} ${o.van_plaats} -> ${o.naar_land} ${o.naar_postcode} ${o.naar_plaats}`, `Laden: ${o.laaddatum_van}${o.laaddatum_tot && o.laaddatum_tot !== o.laaddatum_van ? ' t/m ' + o.laaddatum_tot : ''}`, `Lossen: ${o.losdatum_van}${o.losdatum_tot && o.losdatum_tot !== o.losdatum_van ? ' t/m ' + o.losdatum_tot : ''}`, `Laadmeter: ${o.laadmeter} lm`, `Hoogte: ${o.hoogte} m`]; if (o.gewicht) regels.push(`Gewicht: ${o.gewicht} t`); if (o.type_lading || o.opmerking) regels.push(`Lading/Opmerking: ${[o.type_lading, o.opmerking].filter(Boolean).join(' - ')}`); return regels.join(String.fromCharCode(13,10)); } function mailtoLink(o) { const onderwerp = `${o.van_land} ${o.van_postcode} ${o.van_plaats} -> ${o.naar_land} ${o.naar_postcode} ${o.naar_plaats}`; return `mailto:${o.email}?subject=${encodeURIComponent(onderwerp)}&body=${encodeURIComponent(mailtoBody(o))}`; }  const rows = filtered.map(o => `
    <tr class="${o.status === 'vervuld' ? 'vervuld' : ''}">
      <td><span class="badge badge-${o.type}">${o.type === 'vracht' ? 'Vracht' : 'Combi vrij'}</span></td>
      <td><span class="route-part">${locatie(o.van_land, o.van_postcode, o.van_plaats)}</span> &rarr; <span class="route-part">${locatie(o.naar_land, o.naar_postcode, o.naar_plaats)}</span></td>
      <td>${periode(o.laaddatum_van, o.laaddatum_tot)}${(o.laadtijd_van||o.laadtijd_tot) ? '<br><small>' + esc(o.laadtijd_van||'') + (o.laadtijd_tot ? ' &ndash; ' + esc(o.laadtijd_tot) : '') + '</small>' : ''}</td>
      <td>${periode(o.losdatum_van, o.losdatum_tot)}${(o.lostijd_van||o.lostijd_tot) ? '<br><small>' + esc(o.lostijd_van||'') + (o.lostijd_tot ? ' &ndash; ' + esc(o.lostijd_tot) : '') + '</small>' : ''}</td>
      <td>${esc(o.laadmeter)} lm</td>
      <td>${esc(o.hoogte)} m</td>
      <td>${o.gewicht ? esc(o.gewicht) + ' t' : '-'}</td>
      <td>${o.type_lading ? esc(o.type_lading) : '-'}${o.opmerking ? '<br><small>' + esc(o.opmerking) + '</small>' : ''}</td>
      <td>${esc(o.bedrijf)}<br><small>${esc(o.contactpersoon)} &middot; <a href="tel:${esc(o.telefoon)}">${esc(o.telefoon)}</a>${o.email ? ' &middot; <a href="mailto:' + esc(o.email) + '">' + esc(o.email) + '</a>' : ''}</small></td>
      <td>${o.bedrijf_id === req.bedrijf.id ? `<a href="/aanbieding/${o.id}" class="beheer-icon" title="Bewerken"><img src="/icon-dark.png" alt="Bewerken" class="beheer-icon-img"></a>` : (o.email ? `<a href="${esc(mailtoLink(o))}" class="beheer-icon" title="Mail sturen naar ${esc(o.bedrijf)}"><img src="/icon-white.png" alt="Mail sturen" class="beheer-icon-img"></a>` : `<img src="/icon-white.png" alt="" class="beheer-icon-img beheer-icon-inactive">`)}</td>
    </tr>`).join('');

  const body = `
  <h1>Open aanbiedingen</h1>
  <form class="filters" method="get" action="/overzicht">
    <div class="filter-group">
      <label>Type</label>
      <select name="type">
        <option value="alle" ${type === 'alle' ? 'selected' : ''}>Alle</option>
        <option value="vracht" ${type === 'vracht' ? 'selected' : ''}>Vracht gezocht</option>
        <option value="ruimte" ${type === 'ruimte' ? 'selected' : ''}>Combi vrij</option>
      </select>
    </div>
    <div class="filter-group">
      <label>Van &ndash; land</label>
      <select name="van_land">${landOptions(vanLand, true)}</select>
    </div>
    <div class="filter-group">
      <label>Van &ndash; postcodegebied</label>
      <div class="pc-triplet">
        <input type="text" name="van_pc1" value="${esc(q.van_pc1 || '')}" maxlength="4" placeholder="bijv. 50">
        <input type="text" name="van_pc2" value="${esc(q.van_pc2 || '')}" maxlength="4" placeholder="bijv. 51">
        <input type="text" name="van_pc3" value="${esc(q.van_pc3 || '')}" maxlength="4" placeholder="bijv. 52">
      </div>
    </div>
    <div class="filter-group">
      <label>Naar &ndash; land</label>
      <select name="naar_land">${landOptions(naarLand, true)}</select>
    </div>
    <div class="filter-group">
      <label>Naar &ndash; postcodegebied</label>
      <div class="pc-triplet">
        <input type="text" name="naar_pc1" value="${esc(q.naar_pc1 || '')}" maxlength="4" placeholder="bijv. 2">
        <input type="text" name="naar_pc2" value="${esc(q.naar_pc2 || '')}" maxlength="4" placeholder="bijv. 3">
        <input type="text" name="naar_pc3" value="${esc(q.naar_pc3 || '')}" maxlength="4" placeholder="bijv. 4">
      </div>
    </div>
    <div class="filter-group">
      <label>Laden van&ndash;tot</label>
      <div class="range-pair">
        <input type="date" name="laad_vanaf" value="${esc(laadVanaf)}">
        <span>&ndash;</span>
        <input type="date" name="laad_tot" value="${esc(laadTot)}">
      </div>
    </div>
    <div class="filter-group">
      <label>Lossen van&ndash;tot</label>
      <div class="range-pair">
        <input type="date" name="los_vanaf" value="${esc(losVanaf)}">
        <span>&ndash;</span>
        <input type="date" name="los_tot" value="${esc(losTot)}">
      </div>
    </div>
    <div class="filter-pair">
      <div class="filter-group">
        <label>Laadmeter min&ndash;max</label>
        <div class="range-pair">
          <input type="number" step="0.1" name="lm_min" value="${lmMin}">
          <span>&ndash;</span>
          <input type="number" step="0.1" name="lm_max" value="${lmMax}">
        </div>
      </div>
      <div class="filter-group">
        <label>Hoogte min&ndash;max (m)</label>
        <div class="range-pair">
          <input type="number" step="0.01" name="h_min" value="${hMin}">
          <span>&ndash;</span>
          <input type="number" step="0.01" name="h_max" value="${hMax}">
        </div>
      </div>
    </div>
    <div class="filter-group checkbox-group">
      <label><input type="checkbox" name="toon_afgehandeld" value="1" ${toonAfgehandeld ? 'checked' : ''}> Toon ook afgehandelde</label>
    </div>
    <div class="filter-group">
      <button type="submit">Filteren</button>
      <a href="/overzicht" class="reset-link">reset</a>
    </div>
  </form>

  <table class="offers aanbiedingen">
    <thead>
      <tr>
        <th>Type</th><th>Route</th><th>Laden</th><th>Lossen</th><th>Laadmeter</th><th>Hoogte</th><th>Gewicht</th><th>Lading / opmerking</th><th>Contact</th><th>Actie</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="10" class="empty">Geen aanbiedingen gevonden binnen deze filters.</td></tr>'}
    </tbody>
  </table>
  `;

  res.send(layout(req, 'Combi-Match - Overzicht', body));
}));

// ---------- nieuwe aanbieding: gedeelde formulier-renderer ----------
function nieuwFormBody(modus, bedrijfNaam) {
  const isCapaciteit = modus === 'capaciteit';
  const typeWaarde = isCapaciteit ? 'ruimte' : 'vracht';
  const titel = isCapaciteit ? 'Capaciteit aanbieden' : 'Vracht aanbieden';
  const intro = isCapaciteit
    ? 'Heb je een combi of LZV vrij? Geef door waar hij leeg is, waarheen hij zou moeten en wat de afmetingen zijn, dan kunnen andere bedrijven daarop reageren.'
    : 'Zoek je een combi of LZV voor jouw lading? Vul de gegevens van je vracht in, dan kunnen vervoerders met vrije capaciteit reageren.';

  const gewichtLabel = isCapaciteit
    ? 'Gewicht (ton) &mdash; hoeveel gewicht kan er geladen worden?'
    : 'Gewicht (ton, optioneel)';
  const laadmeterLabel = isCapaciteit
    ? 'Laadmeter &mdash; hoeveel meter is de totale laadruimte?'
    : 'Laadmeter';
  const hoogteLabel = isCapaciteit
    ? 'Hoogte (m) &mdash; wat is de binnenhoogte?'
    : 'Hoogte (m) &mdash; wat is de hoogte van de lading?';
  const ladingLabel = isCapaciteit
    ? 'Lengte &mdash; hoe lang zijn de motorwagen en aanhanger/trailer?'
    : 'Type lading';
  const ladingPlaceholder = isCapaciteit ? 'bijv. 7,20m / 8,30m' : 'bijv. blokpallets';
  const opmerkingPlaceholder = isCapaciteit ? 'bijv. beschikbaar vanaf 14:00' : 'bijv. geen stapelen';

  return `
  <h1>${titel}</h1>
  <p class="form-intro">${intro}</p>
  <form class="offer-form" method="post" action="/nieuw">
    <input type="hidden" name="type" value="${typeWaarde}">
    <div class="form-row two-col">
      <div>
        <label>Van &ndash; land</label>
        <select name="van_land">${landOptions('NL', false)}</select>
      </div>
      <div>
        <label>Van &ndash; postcode</label>
        <input type="text" name="van_postcode" placeholder="bijv. 3011">
      </div>
      <div>
        <label>Van &ndash; plaats</label>
        <input type="text" name="van_plaats" required placeholder="bijv. Rotterdam">
      </div>
    </div>
    <div class="form-row two-col">
      <div>
        <label>Naar &ndash; land</label>
        <select name="naar_land">${landOptions('IT', false)}</select>
      </div>
      <div>
        <label>Naar &ndash; postcode</label>
        <input type="text" name="naar_postcode" placeholder="bijv. 20100">
      </div>
      <div>
        <label>Naar &ndash; plaats</label>
        <input type="text" name="naar_plaats" required placeholder="bijv. Milaan">
      </div>
    </div>
    <div class="form-row two-col">
      <div>
        <label>Laaddatum van</label>
        <input type="date" name="laaddatum_van" required></div><div class="two-col"><div><label>Openingstijd van (optioneel)</label><input type="time" name="laadtijd_van"></div><div><label>Openingstijd tot (optioneel)</label><input type="time" name="laadtijd_tot"></div></div><div><label>Laaddatum tot (optioneel)</label><input type="date" name="laaddatum_tot">
      </div>
    </div>
    <div class="form-row two-col">
      <div>
        <label>Losdatum van</label>
        <input type="date" name="losdatum_van" required></div><div class="two-col"><div><label>Openingstijd van (optioneel)</label><input type="time" name="lostijd_van"></div><div><label>Openingstijd tot (optioneel)</label><input type="time" name="lostijd_tot"></div></div><div><label>Losdatum tot (optioneel)</label><input type="date" name="losdatum_tot">
      </div>
    </div>
    <div class="form-row">
      <label>${gewichtLabel}</label>
      <input type="number" step="0.1" min="0" name="gewicht" placeholder="bijv. 12">
    </div>
    <div class="form-row two-col">
      <div>
        <label>${laadmeterLabel}</label>
        <input type="number" step="any" min="13.65" max="22.0" name="laadmeter" required placeholder="bijv. 15.5">
      </div>
      <div>
        <label>${hoogteLabel}</label>
        <input type="number" step="0.01" min="0.1" max="3.10" name="hoogte" required placeholder="bijv. 3.00">
      </div>
    </div>
    <div class="form-row two-col">
      <div>
        <label>${ladingLabel}</label>
        <input type="text" name="type_lading" placeholder="${ladingPlaceholder}">
      </div>
      <div>
        <label>Opmerking</label>
        <input type="text" name="opmerking" placeholder="${opmerkingPlaceholder}">
      </div>
    </div>
    <div class="form-row two-col">
      <div>
        <label>Bedrijfsnaam</label>
        <input type="text" name="bedrijf" value="${esc(bedrijfNaam)}" readonly>
      </div>
      <div>
        <label>Contactpersoon</label>
        <input type="text" name="contactpersoon" required>
      </div>
    </div>
    <div class="form-row two-col">
      <div>
        <label>Telefoon</label>
        <input type="text" name="telefoon" required>
      </div>
      <div>
        <label>E-mail (optioneel)</label>
        <input type="email" name="email">
      </div>
    </div>
    <div class="form-row">
      <button type="submit">Plaatsen</button>
    </div>
  </form>
  `;
}

app.get('/nieuw/vracht', requireLogin, (req, res) => {
  res.send(layout(req, 'Combi-Match - Vracht aanbieden', nieuwFormBody('vracht', req.bedrijf.naam)));
});

app.get('/nieuw/capaciteit', requireLogin, (req, res) => {
  res.send(layout(req, 'Combi-Match - Capaciteit aanbieden', nieuwFormBody('capaciteit', req.bedrijf.naam)));
});

// oude link blijft werken
app.get('/nieuw', requireLogin, (req, res) => res.redirect('/nieuw/vracht'));

// create offer
app.post('/nieuw', requireLogin, ah(async (req, res) => {
  const id = crypto.randomUUID();
  const laaddatumVan = req.body.laaddatum_van || '';
  const losdatumVan = req.body.losdatum_van || '';

  const offer = {
    id,
    type: req.body.type === 'ruimte' ? 'ruimte' : 'vracht',
    van_land: req.body.van_land || '',
    van_postcode: req.body.van_postcode || '',
    van_plaats: req.body.van_plaats || '',
    naar_land: req.body.naar_land || '',
    naar_postcode: req.body.naar_postcode || '',
    naar_plaats: req.body.naar_plaats || '',
    laaddatum_van: laaddatumVan,
    laaddatum_tot: req.body.laaddatum_tot || laaddatumVan,
    losdatum_van: losdatumVan,
    losdatum_tot: req.body.losdatum_tot || losdatumVan,
    laadmeter: req.body.laadmeter || '',
    hoogte: req.body.hoogte || '',
    gewicht: req.body.gewicht || '',
    type_lading: req.body.type_lading || '',
    opmerking: req.body.opmerking || '',
    bedrijf: req.body.bedrijf || '',
    contactpersoon: req.body.contactpersoon || '',
    telefoon: req.body.telefoon || '',
    email: req.body.email || '',
    status: 'open',
    bedrijf_id: req.bedrijf.id, laadtijd_van: req.body.laadtijd_van || '', laadtijd_tot: req.body.laadtijd_tot || '', lostijd_van: req.body.lostijd_van || '', lostijd_tot: req.body.lostijd_tot || '',
  };

  await pool.query(
    `INSERT INTO offers (id, type, van_land, van_postcode, van_plaats, naar_land, naar_postcode, naar_plaats,
      laaddatum_van, laaddatum_tot, losdatum_van, losdatum_tot, laadmeter, hoogte, gewicht,
      type_lading, opmerking, bedrijf, contactpersoon, telefoon, email, status, bedrijf_id, laadtijd_van, laadtijd_tot, lostijd_van, lostijd_tot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [offer.id, offer.type, offer.van_land, offer.van_postcode, offer.van_plaats,
     offer.naar_land, offer.naar_postcode, offer.naar_plaats,
     offer.laaddatum_van, offer.laaddatum_tot, offer.losdatum_van, offer.losdatum_tot,
     offer.laadmeter, offer.hoogte, offer.gewicht, offer.type_lading, offer.opmerking,
     offer.bedrijf, offer.contactpersoon, offer.telefoon, offer.email, offer.status, offer.bedrijf_id, offer.laadtijd_van, offer.laadtijd_tot, offer.lostijd_van, offer.lostijd_tot]
  );

  const body = `
    <h1>Aanbieding geplaatst</h1>
    <p>Je aanbieding staat nu in het overzicht.</p>
    <p><a href="/overzicht">Naar het overzicht</a> &middot; <a href="/">Terug naar home</a></p>
  `;
  res.send(layout(req, 'Combi-Match - Geplaatst', body));
}));

// manage single offer (mark done / delete)
app.get('/aanbieding/:id', requireLogin, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM offers WHERE id = $1', [req.params.id]);
  const offer = rows[0];
  if (!offer) return res.status(404).send(layout(req, 'Niet gevonden', '<p>Aanbieding niet gevonden.</p>'));
  if (offer.bedrijf_id !== req.bedrijf.id) {
    return res.status(403).send(layout(req, 'Geen toegang', '<p>Je hebt geen toegang tot deze aanbieding. <a href="/overzicht">Terug naar overzicht</a></p>'));
  }

  const opgeslagen = req.query.opgeslagen === '1';

  const body = `
    <h1>Aanbieding bewerken</h1>
    ${opgeslagen ? '<p style="color:#012750;font-weight:600;">Wijzigingen opgeslagen.</p>' : ''}
    <form class="offer-form" method="post" action="/aanbieding/${offer.id}/bewerken">
      <div class="form-row">
        <label>Type aanbieding</label>
        <select name="type" required>
          <option value="vracht" ${offer.type === 'vracht' ? 'selected' : ''}>Vracht aanbieden (Ik zoek een vervoerder met een combi)</option>
          <option value="ruimte" ${offer.type === 'ruimte' ? 'selected' : ''}>Capaciteit aanbieden (Ik heb een combi beschikbaar)</option>
        </select>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Van &ndash; land</label>
          <select name="van_land">${landOptions(offer.van_land, false)}</select>
        </div>
        <div>
          <label>Van &ndash; postcode</label>
          <input type="text" name="van_postcode" value="${esc(offer.van_postcode)}">
        </div>
        <div>
          <label>Van &ndash; plaats</label>
          <input type="text" name="van_plaats" required value="${esc(offer.van_plaats)}">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Naar &ndash; land</label>
          <select name="naar_land">${landOptions(offer.naar_land, false)}</select>
        </div>
        <div>
          <label>Naar &ndash; postcode</label>
          <input type="text" name="naar_postcode" value="${esc(offer.naar_postcode)}">
        </div>
        <div>
          <label>Naar &ndash; plaats</label>
          <input type="text" name="naar_plaats" required value="${esc(offer.naar_plaats)}">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Laaddatum van</label>
          <input type="date" name="laaddatum_van" required value="${esc(offer.laaddatum_van)}"></div><div class="two-col"><div><label>Openingstijd van (optioneel)</label><input type="time" name="laadtijd_van" value="${esc(offer.laadtijd_van)}"></div><div><label>Openingstijd tot (optioneel)</label><input type="time" name="laadtijd_tot" value="${esc(offer.laadtijd_tot)}"></div></div><div><label>Laaddatum tot (optioneel)</label><input type="date" name="laaddatum_tot" value="${esc(offer.laaddatum_tot)}">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Losdatum van</label>
          <input type="date" name="losdatum_van" required value="${esc(offer.losdatum_van)}"></div><div class="two-col"><div><label>Openingstijd van (optioneel)</label><input type="time" name="lostijd_van" value="${esc(offer.lostijd_van)}"></div><div><label>Openingstijd tot (optioneel)</label><input type="time" name="lostijd_tot" value="${esc(offer.lostijd_tot)}"></div></div><div><label>Losdatum tot (optioneel)</label><input type="date" name="losdatum_tot" value="${esc(offer.losdatum_tot)}">
        </div>
      </div>
      <div class="form-row">
        <label>Gewicht (ton, optioneel)</label>
        <input type="number" step="0.1" min="0" name="gewicht" value="${esc(offer.gewicht)}">
      </div>
      <div class="form-row two-col">
        <div>
          <label>Laadmeter</label>
          <input type="number" step="any" min="13.65" max="22.0" name="laadmeter" required value="${esc(offer.laadmeter)}">
        </div>
        <div>
          <label>Hoogte (m)</label>
          <input type="number" step="0.01" min="0.1" max="3.10" name="hoogte" required value="${esc(offer.hoogte)}">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Type lading</label>
          <input type="text" name="type_lading" value="${esc(offer.type_lading)}">
        </div>
        <div>
          <label>Opmerking</label>
          <input type="text" name="opmerking" value="${esc(offer.opmerking)}">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Bedrijfsnaam</label>
          <input type="text" name="bedrijf" required value="${esc(offer.bedrijf)}">
        </div>
        <div>
          <label>Contactpersoon</label>
          <input type="text" name="contactpersoon" required value="${esc(offer.contactpersoon)}">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Telefoon</label>
          <input type="text" name="telefoon" required value="${esc(offer.telefoon)}">
        </div>
        <div>
          <label>E-mail (optioneel)</label>
          <input type="email" name="email" value="${esc(offer.email)}">
        </div>
      </div>
      <div class="form-row">
        <button type="submit">Wijzigingen opslaan</button>
      </div>
    </form>
    <form method="post" action="/aanbieding/${offer.id}/status" style="margin-top:16px;">
      <button type="submit" name="actie" value="vervuld">Markeer als afgehandeld</button> <button type="submit" name="actie" value="heropenen">Heropenen</button>
      <button type="submit" name="actie" value="verwijderen" onclick="return confirm('Weet je zeker dat je deze aanbieding wilt verwijderen? Dit kan niet ongedaan worden gemaakt.')">Verwijderen</button>
    </form>
  `;
  res.send(layout(req, 'Combi-Match - Bewerken', body));
}));

app.post('/aanbieding/:id/bewerken', requireLogin, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM offers WHERE id = $1', [req.params.id]);
  const offer = rows[0];
  if (!offer) return res.status(404).send(layout(req, 'Niet gevonden', '<p>Aanbieding niet gevonden. <a href="/overzicht">Terug</a></p>'));
  if (offer.bedrijf_id !== req.bedrijf.id) {
    return res.status(403).send(layout(req, 'Geen toegang', '<p>Je hebt geen toegang tot deze aanbieding. <a href="/overzicht">Terug naar overzicht</a></p>'));
  }

  const laaddatumVan = req.body.laaddatum_van || offer.laaddatum_van;
  const losdatumVan = req.body.losdatum_van || offer.losdatum_van;

  const bijgewerkt = {
    type: req.body.type === 'ruimte' ? 'ruimte' : 'vracht',
    van_land: req.body.van_land || '',
    van_postcode: req.body.van_postcode || '',
    van_plaats: req.body.van_plaats || '',
    naar_land: req.body.naar_land || '',
    naar_postcode: req.body.naar_postcode || '',
    naar_plaats: req.body.naar_plaats || '',
    laaddatum_van: laaddatumVan,
    laaddatum_tot: req.body.laaddatum_tot || laaddatumVan,
    losdatum_van: losdatumVan,
    losdatum_tot: req.body.losdatum_tot || losdatumVan,
    laadmeter: req.body.laadmeter || '',
    hoogte: req.body.hoogte || '',
    gewicht: req.body.gewicht || '',
    type_lading: req.body.type_lading || '',
    opmerking: req.body.opmerking || '',
    bedrijf: req.body.bedrijf || '',
    contactpersoon: req.body.contactpersoon || '',
    telefoon: req.body.telefoon || '',
    email: req.body.email || '',
  };

  await pool.query(
    `UPDATE offers SET type=$1, status = CASE WHEN status = 'vervuld' AND COALESCE(NULLIF($11,''), $10)::date >= CURRENT_DATE THEN 'open' ELSE status END, van_land=$2, van_postcode=$3, van_plaats=$4, naar_land=$5, naar_postcode=$6,
      naar_plaats=$7, laaddatum_van=$8, laaddatum_tot=$9, losdatum_van=$10, losdatum_tot=$11, laadmeter=$12,
      hoogte=$13, gewicht=$14, type_lading=$15, opmerking=$16, bedrijf=$17, contactpersoon=$18, telefoon=$19,
      email=$20, laadtijd_van=$22, laadtijd_tot=$23, lostijd_van=$24, lostijd_tot=$25 WHERE id=$21`,
    [bijgewerkt.type, bijgewerkt.van_land, bijgewerkt.van_postcode, bijgewerkt.van_plaats,
     bijgewerkt.naar_land, bijgewerkt.naar_postcode, bijgewerkt.naar_plaats,
     bijgewerkt.laaddatum_van, bijgewerkt.laaddatum_tot, bijgewerkt.losdatum_van, bijgewerkt.losdatum_tot,
     bijgewerkt.laadmeter, bijgewerkt.hoogte, bijgewerkt.gewicht, bijgewerkt.type_lading, bijgewerkt.opmerking,
     bijgewerkt.bedrijf, bijgewerkt.contactpersoon, bijgewerkt.telefoon, bijgewerkt.email, offer.id, req.body.laadtijd_van || '', req.body.laadtijd_tot || '', req.body.lostijd_van || '', req.body.lostijd_tot || '']
  );

  res.redirect('/overzicht');
}));

app.post('/aanbieding/:id/status', requireLogin, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM offers WHERE id = $1', [req.params.id]);
  const offer = rows[0];
  if (!offer) {
    return res.status(404).send(layout(req, 'Niet gevonden', '<p>Aanbieding niet gevonden. <a href="/overzicht">Terug</a></p>'));
  }
  if (offer.bedrijf_id !== req.bedrijf.id) {
    return res.status(403).send(layout(req, 'Geen toegang', '<p>Je hebt geen toegang tot deze aanbieding. <a href="/overzicht">Terug naar overzicht</a></p>'));
  }
  if (req.body.actie === 'verwijderen') {
    await archiveerAanbieding(offer); await pool.query('DELETE FROM offers WHERE id = $1', [offer.id]);
  } else {
    await pool.query(req.body.actie === 'heropenen' ? "UPDATE offers SET status = 'open' WHERE id = $1" : "UPDATE offers SET status = 'vervuld' WHERE id = $1", [offer.id]);
  }
  res.redirect('/overzicht');
}));

// ---------- admin: bedrijven / toegangscodes ----------
app.get('/admin/login', (req, res) => {
  const next = req.query.next || '/admin';
  const fout = req.query.fout === '1'; const geblokkeerd = req.query.fout === '2';
  const body = `
  <h1>Beheer &ndash; inloggen</h1>
  ${fout ? '<p style="color:#b00020;font-weight:600;">Wachtwoord onjuist.</p>' : ''}${geblokkeerd ? '<p style="color:#b00020;font-weight:600;">Te veel mislukte pogingen. Probeer het over 15 minuten opnieuw.</p>' : ''}
  <form class="offer-form" method="post" action="/admin/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <div class="form-row">
      <label>Beheerderswachtwoord</label>
      <input type="password" name="wachtwoord" required autofocus>
    </div>
    <div class="form-row">
      <button type="submit">Inloggen</button>
    </div>
  </form>
  `;
  res.send(layout(req, 'Combi-Match - Beheer inloggen', body));
});

app.post('/admin/login', (req, res) => {
  const next = req.body.next || '/admin'; const rlKeyAdmin = 'admin:' + req.ip; const wachtMinAdmin = rateLimitCheck(rlKeyAdmin); if (wachtMinAdmin > 0) { return res.redirect(`/admin/login?fout=2&next=${encodeURIComponent(next)}`); }
  if ((req.body.wachtwoord || '') !== ADMIN_WACHTWOORD) {
    rateLimitMislukt(rlKeyAdmin); return res.redirect(`/admin/login?fout=1&next=${encodeURIComponent(next)}`);
  }
  rateLimitReset(rlKeyAdmin); res.cookie('admin_sessie', sign('admin-sessie-marker'), { httpOnly: true, secure: true, maxAge: 1000 * 60 * 60 * 12, sameSite: 'lax' });
  res.redirect(next);
});

app.get('/admin/uitloggen', (req, res) => {
  res.clearCookie('admin_sessie');
  res.redirect('/');
});

app.get('/admin', requireAdmin, ah(async (req, res) => {
  const { rows: companies } = await pool.query('SELECT * FROM companies');
  companies.sort((a, b) => new Date(b.aangemaakt_op) - new Date(a.aangemaakt_op));
  const nieuwId = req.query.nieuw;

  const { rows: weesAanbiedingen } = await pool.query('SELECT * FROM offers WHERE bedrijf_id IS NULL');

  const rows = companies.map(c => `
    <tr>
      <td>${esc(c.naam)}</td>
      <td><span class="code">${esc(c.code)}</span>${c.id === nieuwId ? ' <strong style="color:#012750;">(nieuw)</strong>' : ''}</td>
      <td>${c.actief ? 'Actief' : 'Ingetrokken'}</td>
      <td>${esc(String(c.aangemaakt_op).slice(0, 10))}</td>
      <td style="white-space:nowrap;">
        <form method="post" action="/admin/bedrijven/${c.id}/toggle" style="display:inline;">
          <button type="submit">${c.actief ? 'Intrekken' : 'Heractiveren'}</button>
        </form>
        <form method="post" action="/admin/bedrijven/${c.id}/verwijderen" style="display:inline;" onsubmit="return confirm('Dit bedrijf en de bijbehorende code definitief verwijderen?')">
          <button type="submit">Verwijderen</button>
        </form>
      </td>
    </tr>`).join('');

  const body = `
  <h1>Beheer &ndash; bedrijven &amp; toegangscodes</h1>
  <p class="form-intro">Voeg hier bedrijven toe en geef ze de gegenereerde code door. Met die code kunnen ze inloggen op de portal.</p>

  <form class="offer-form" method="post" action="/admin/bedrijven" style="margin-bottom:24px;max-width:480px;">
    <div class="form-row">
      <label>Nieuw bedrijf &ndash; naam</label>
      <input type="text" name="naam" required placeholder="bijv. Jansen Transport BV">
    </div>
    <div class="form-row">
      <button type="submit">Toevoegen &amp; code genereren</button>
    </div>
  </form>

  <table class="offers bedrijven">
    <thead>
      <tr><th>Bedrijf</th><th>Code</th><th>Status</th><th>Toegevoegd</th><th></th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="5" class="empty">Nog geen bedrijven toegevoegd.</td></tr>'}
    </tbody>
  </table>

  ${weesAanbiedingen.length ? `
  <h2 style="margin-top:32px;">Niet-gekoppelde aanbiedingen (${weesAanbiedingen.length})</h2>
  <p class="form-intro">Deze aanbiedingen zijn niet gekoppeld aan een bedrijfsaccount (bijv. oude testdata) en zijn daardoor door niemand via de portal te beheren.</p>
  <table class="offers">
    <thead>
      <tr><th>Type</th><th>Route</th><th>Bedrijf (vrije tekst)</th></tr>
    </thead>
    <tbody>
      ${weesAanbiedingen.map(o => `
      <tr>
        <td>${esc(o.type)}</td>
        <td>${esc(o.van_plaats)} &rarr; ${esc(o.naar_plaats)}</td>
        <td>${esc(o.bedrijf)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <form method="post" action="/admin/aanbiedingen/opschonen" style="margin-top:12px;" onsubmit="return confirm('Alle niet-gekoppelde aanbiedingen definitief verwijderen?')">
    <button type="submit">Niet-gekoppelde aanbiedingen verwijderen</button>
  </form>
  ` : ''}

  <p style="margin-top:20px;"><a href="/admin/archief">Archief bekijken</a> &middot; <a href="/admin/uitloggen">Uitloggen uit beheer</a></p>
  `;
  res.send(layout(req, 'Combi-Match - Beheer', body));
}));

app.post('/admin/aanbiedingen/opschonen', requireAdmin, ah(async (req, res) => {
  const { rows: teArchiveren } = await pool.query('SELECT * FROM offers WHERE bedrijf_id IS NULL'); for (const o of teArchiveren) { await archiveerAanbieding(o); } await pool.query('DELETE FROM offers WHERE bedrijf_id IS NULL');
  res.redirect('/admin');
}));

app.get('/admin/archief', requireAdmin, ah(async (req, res) => { const { rows: archief } = await pool.query('SELECT * FROM archief ORDER BY offline_sinds DESC'); function periodeA(van_, tot_) { const fmt = d => { const p = (d||'').split('-'); return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : (d||''); }; if (!van_) return '-'; if (!tot_ || tot_ === van_) return esc(fmt(van_)); return `${esc(fmt(van_))}<br>&ndash; ${esc(fmt(tot_))}`; } function fmtDatumTijd(d) { if (!d) return '-'; const dt = new Date(d); return dt.toLocaleDateString('nl-NL') + ' ' + dt.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }); } const rijen = archief.map(o => `<tr><td><span class="badge badge-${o.type}">${o.type === 'vracht' ? 'Vracht' : 'Combi vrij'}</span></td><td><span class="route-part">${locatie(o.van_land, o.van_postcode, o.van_plaats)}</span> &rarr; <span class="route-part">${locatie(o.naar_land, o.naar_postcode, o.naar_plaats)}</span></td><td>${periodeA(o.laaddatum_van, o.laaddatum_tot)}</td><td>${periodeA(o.losdatum_van, o.losdatum_tot)}</td><td>${esc(o.laadmeter)} lm</td><td>${esc(o.hoogte)} m</td><td>${o.gewicht ? esc(o.gewicht) + ' t' : '-'}</td><td>${o.type_lading ? esc(o.type_lading) : '-'}${o.opmerking ? '<br><small>' + esc(o.opmerking) + '</small>' : ''}</td><td>${esc(o.bedrijf)}<br><small>${esc(o.contactpersoon)} &middot; ${esc(o.telefoon)}${o.email ? ' &middot; ' + esc(o.email) : ''}</small></td><td>${fmtDatumTijd(o.online_sinds)}</td><td>${fmtDatumTijd(o.offline_sinds)}</td></tr>`).join(''); const body = `<h1>Archief &ndash; verwijderde aanbiedingen</h1><p class="form-intro">Overzicht van alle aanbiedingen die verwijderd of automatisch opgeruimd zijn, inclusief wanneer ze online geplaatst en offline gehaald zijn.</p><table class="offers archief"><thead><tr><th>Type</th><th>Route</th><th>Laden</th><th>Lossen</th><th>Laadmeter</th><th>Hoogte</th><th>Gewicht</th><th>Lading / opmerking</th><th>Contact</th><th>Online sinds</th><th>Offline sinds</th></tr></thead><tbody>${rijen || '<tr><td colspan="11" class="empty">Nog geen aanbiedingen gearchiveerd.</td></tr>'}</tbody></table><p style="margin-top:20px;"><a href="/admin/archief/export">Exporteren naar Excel (CSV)</a></p><form method="post" action="/admin/archief/legen" style="margin-top:12px;" onsubmit="return confirm('Weet je zeker dat je het hele archief wilt legen? Download eerst de export als je de data wilt bewaren. Dit kan niet ongedaan worden gemaakt.')"><button type="submit">Archief legen</button></form><p style="margin-top:20px;"><a href="/admin">Terug naar beheer</a></p>`; res.send(layout(req, 'Combi-Match - Archief', body, { wideMain: true })); })); app.get('/admin/archief/export', requireAdmin, ah(async (req, res) => { const { rows: archief } = await pool.query('SELECT * FROM archief ORDER BY offline_sinds DESC'); const kolommen = ['type','van_land','van_postcode','van_plaats','naar_land','naar_postcode','naar_plaats','laaddatum_van','laaddatum_tot','losdatum_van','losdatum_tot','laadmeter','hoogte','gewicht','type_lading','opmerking','bedrijf','contactpersoon','telefoon','email','online_sinds','offline_sinds']; function csvCel(v) { const s = v === null || v === undefined ? '' : String(v); return '"' + s.split('"').join('""') + '"'; } const eol = String.fromCharCode(13,10); const csvRegels = [kolommen.join(';')].concat(archief.map(o => kolommen.map(k => csvCel(o[k])).join(';'))); const csv = csvRegels.join(eol); res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="combimatch-archief.csv"'); res.send(String.fromCharCode(65279) + csv); })); app.post('/admin/archief/legen', requireAdmin, ah(async (req, res) => { await pool.query('DELETE FROM archief'); res.redirect('/admin/archief'); })); function genCode(lengte = 6) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // zonder verwarrende tekens (O/0, I/1/L)
  let code = '';
  for (let i = 0; i < lengte; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

app.post('/admin/bedrijven', requireAdmin, ah(async (req, res) => {
  const naam = (req.body.naam || '').trim();
  if (!naam) return res.redirect('/admin');
  const id = crypto.randomUUID();
  const code = genCode();
  await pool.query(
    'INSERT INTO companies (id, naam, code, actief) VALUES ($1, $2, $3, true)',
    [id, naam, code]
  );
  res.redirect(`/admin?nieuw=${id}`);
}));

app.post('/admin/bedrijven/:id/toggle', requireAdmin, ah(async (req, res) => {
  await pool.query('UPDATE companies SET actief = NOT actief WHERE id = $1', [req.params.id]);
  res.redirect('/admin');
}));

app.post('/admin/bedrijven/:id/verwijderen', requireAdmin, ah(async (req, res) => {
  await pool.query('DELETE FROM companies WHERE id = $1', [req.params.id]);
  res.redirect('/admin');
}));

// generieke foutafhandeling voor async routes
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Er ging iets mis. Probeer het later opnieuw.');
});

async function onderhoudAanbiedingen() { await pool.query("UPDATE offers SET status = 'vervuld' WHERE status = 'open' AND COALESCE(NULLIF(losdatum_tot, ''), losdatum_van)::date < CURRENT_DATE"); const { rows: teArchiverenVerlopen } = await pool.query("SELECT * FROM offers WHERE status = 'vervuld' AND COALESCE(NULLIF(losdatum_tot, ''), losdatum_van)::date < CURRENT_DATE - INTERVAL '7 days'"); for (const o of teArchiverenVerlopen) { await archiveerAanbieding(o); } await pool.query("DELETE FROM offers WHERE status = 'vervuld' AND COALESCE(NULLIF(losdatum_tot, ''), losdatum_van)::date < CURRENT_DATE - INTERVAL '7 days'"); } async function start() {
  await migreer(); await onderhoudAanbiedingen(); setInterval(onderhoudAanbiedingen, 60 * 60 * 1000);
  app.listen(PORT, () => {
    console.log(`Combi-Match draait op http://localhost:${PORT}`);
  });
}

start().catch(e => {
  console.error('Kon niet starten:', e);
  process.exit(1);
});
