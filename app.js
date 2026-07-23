const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const DATA_FILE = path.join(__dirname, 'data', 'offers.json');
const PORT = process.env.PORT || 3000;

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

// ---------- data helpers ----------
function loadOffers() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveOffers(offers) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(offers, null, 2));
}

function esc(str = '') {
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
function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <a href="/" class="logo">Combi-beurs</a>
    <nav>
      <a href="/">Overzicht</a>
      <a href="/nieuw">Aanbieding plaatsen</a>
    </nav>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="wrap footer">
  <p>Betrouwbaar transport sinds 1850 &mdash; interne beurs voor combi's (14&ndash;15,6 laadmeter, 2,60&ndash;3,05m hoogte)</p>
</footer>
</body>
</html>`;
}

function locatie(land, postcode, plaats) {
  const parts = [land, postcode].filter(Boolean).join('-');
  return [parts, plaats].filter(Boolean).join(' ') || '-';
}

// ---------- routes ----------

// overview + filters
app.get('/', (req, res) => {
  const offers = loadOffers().sort((a, b) => new Date(b.geplaatst_op) - new Date(a.geplaatst_op));

  const q = req.query;
  const type = q.type || 'alle';
  const vanLand = q.van_land || 'alle';
  const naarLand = q.naar_land || 'alle';
  const vanTekst = (q.van || '').toLowerCase();
  const naarTekst = (q.naar || '').toLowerCase();
  const laadVanaf = q.laad_vanaf || '';
  const laadTot = q.laad_tot || '';
  const losVanaf = q.los_vanaf || '';
  const losTot = q.los_tot || '';
  const lmMin = q.lm_min !== undefined && q.lm_min !== '' ? parseFloat(q.lm_min) : 14;
  const lmMax = q.lm_max !== undefined && q.lm_max !== '' ? parseFloat(q.lm_max) : 15.6;
  const hMin = q.h_min !== undefined && q.h_min !== '' ? parseFloat(q.h_min) : 2.6;
  const hMax = q.h_max !== undefined && q.h_max !== '' ? parseFloat(q.h_max) : 3.05;
  const toonAfgehandeld = q.toon_afgehandeld === '1';

  function overlapt(startO, eindO, filterVanaf, filterTot) {
    if (!filterVanaf && !filterTot) return true;
    const vanaf = filterVanaf || '0000-01-01';
    const tot = filterTot || '9999-12-31';
    const oVan = startO || '0000-01-01';
    const oTot = eindO || oVan;
    return oVan <= tot && vanaf <= oTot;
  }

  function matchLocatie(land, postcode, plaats, filterLand, filterTekst) {
    if (filterLand && filterLand !== 'alle' && land !== filterLand) return false;
    if (filterTekst) {
      const hay = `${postcode || ''} ${plaats || ''}`.toLowerCase();
      if (!hay.includes(filterTekst)) return false;
    }
    return true;
  }

  const filtered = offers.filter(o => {
    if (!toonAfgehandeld && o.status === 'vervuld') return false;
    if (type !== 'alle' && o.type !== type) return false;
    if (!matchLocatie(o.van_land, o.van_postcode, o.van_plaats, vanLand, vanTekst)) return false;
    if (!matchLocatie(o.naar_land, o.naar_postcode, o.naar_plaats, naarLand, naarTekst)) return false;
    if (!overlapt(o.laaddatum_van, o.laaddatum_tot, laadVanaf, laadTot)) return false;
    if (!overlapt(o.losdatum_van, o.losdatum_tot, losVanaf, losTot)) return false;
    const lm = parseFloat(o.laadmeter);
    if (!isNaN(lm) && (lm < lmMin || lm > lmMax)) return false;
    const h = parseFloat(o.hoogte);
    if (!isNaN(h) && (h < hMin || h > hMax)) return false;
    return true;
  });

  function periode(van_, tot_) {
    if (!van_) return '-';
    if (!tot_ || tot_ === van_) return esc(van_);
    return `${esc(van_)} &ndash; ${esc(tot_)}`;
  }

  const rows = filtered.map(o => `
    <tr class="${o.status === 'vervuld' ? 'vervuld' : ''}">
      <td><span class="badge badge-${o.type}">${o.type === 'vracht' ? 'Vracht' : 'Combi vrij'}</span></td>
      <td>${esc(locatie(o.van_land, o.van_postcode, o.van_plaats))} &rarr; ${esc(locatie(o.naar_land, o.naar_postcode, o.naar_plaats))}</td>
      <td>${periode(o.laaddatum_van, o.laaddatum_tot)}</td>
      <td>${periode(o.losdatum_van, o.losdatum_tot)}</td>
      <td>${esc(o.laadmeter)} lm</td>
      <td>${esc(o.hoogte)} m</td>
      <td>${o.gewicht ? esc(o.gewicht) + ' t' : '-'}</td>
      <td>${esc(o.omschrijving || '-')}</td>
      <td>${esc(o.bedrijf)}<br><small>${esc(o.contactpersoon)} &middot; ${esc(o.telefoon)}${o.email ? ' &middot; ' + esc(o.email) : ''}</small></td>
      <td><a href="/aanbieding/${o.id}?code=" class="beheer-link">beheren</a></td>
    </tr>`).join('');

  const body = `
  <h1>Open aanbiedingen</h1>
  <form class="filters" method="get" action="/">
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
      <label>Van &ndash; postcode/plaats</label>
      <input type="text" name="van" value="${esc(q.van || '')}" placeholder="bijv. 3011 of Rotterdam">
    </div>
    <div class="filter-group">
      <label>Naar &ndash; land</label>
      <select name="naar_land">${landOptions(naarLand, true)}</select>
    </div>
    <div class="filter-group">
      <label>Naar &ndash; postcode/plaats</label>
      <input type="text" name="naar" value="${esc(q.naar || '')}" placeholder="bijv. 20100 of Milaan">
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
    <div class="filter-group checkbox-group">
      <label><input type="checkbox" name="toon_afgehandeld" value="1" ${toonAfgehandeld ? 'checked' : ''}> Toon ook afgehandelde</label>
    </div>
    <div class="filter-group">
      <button type="submit">Filteren</button>
      <a href="/" class="reset-link">reset</a>
    </div>
  </form>

  <table class="offers">
    <thead>
      <tr>
        <th>Type</th><th>Route</th><th>Laden</th><th>Lossen</th><th>Laadmeter</th><th>Hoogte</th><th>Gewicht</th><th>Lading / opmerking</th><th>Contact</th><th></th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="10" class="empty">Geen aanbiedingen gevonden binnen deze filters.</td></tr>'}
    </tbody>
  </table>
  `;

  res.send(layout('Combi-beurs — Overzicht', body));
});

// new offer form
app.get('/nieuw', (req, res) => {
  const body = `
  <h1>Nieuwe aanbieding plaatsen</h1>
  <form class="offer-form" method="post" action="/nieuw">
    <div class="form-row">
      <label>Type aanbieding</label>
      <select name="type" required>
        <option value="vracht">Ik zoek een combi (vracht aanbieden)</option>
        <option value="ruimte">Ik heb een combi vrij (laadruimte aanbieden)</option>
      </select>
    </div>
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
        <input type="date" name="laaddatum_van" required>
      </div>
      <div>
        <label>Laaddatum tot (optioneel)</label>
        <input type="date" name="laaddatum_tot">
      </div>
    </div>
    <div class="form-row two-col">
      <div>
        <label>Losdatum van</label>
        <input type="date" name="losdatum_van" required>
      </div>
      <div>
        <label>Losdatum tot (optioneel)</label>
        <input type="date" name="losdatum_tot">
      </div>
    </div>
    <div class="form-row">
      <label>Gewicht (ton, optioneel)</label>
      <input type="number" step="0.1" min="0" name="gewicht" placeholder="bijv. 12">
    </div>
    <div class="form-row two-col">
      <div>
        <label>Laadmeter (14&ndash;15,6)</label>
        <input type="number" step="0.1" min="0" max="15.6" name="laadmeter" required placeholder="bijv. 15.5">
      </div>
      <div>
        <label>Hoogte (2,60&ndash;3,05 m)</label>
        <input type="number" step="0.01" min="0" max="3.05" name="hoogte" required placeholder="bijv. 3.00">
      </div>
    </div>
    <div class="form-row">
      <label>Type lading / opmerking</label>
      <input type="text" name="omschrijving" placeholder="bijv. blokpallets, geen stapelen">
    </div>
    <div class="form-row two-col">
      <div>
        <label>Bedrijfsnaam</label>
        <input type="text" name="bedrijf" required>
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
  res.send(layout('Combi-beurs — Nieuwe aanbieding', body));
});

// create offer
app.post('/nieuw', (req, res) => {
  const offers = loadOffers();
  const id = crypto.randomUUID();
  const code = Math.floor(1000 + Math.random() * 9000).toString();

  const laaddatumVan = req.body.laaddatum_van || '';
  const losdatumVan = req.body.losdatum_van || '';

  const offer = {
    id,
    code,
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
    omschrijving: req.body.omschrijving || '',
    bedrijf: req.body.bedrijf || '',
    contactpersoon: req.body.contactpersoon || '',
    telefoon: req.body.telefoon || '',
    email: req.body.email || '',
    status: 'open',
    geplaatst_op: new Date().toISOString(),
  };

  offers.push(offer);
  saveOffers(offers);

  const body = `
    <h1>Aanbieding geplaatst</h1>
    <p>Je aanbieding staat nu in het overzicht.</p>
    <p><strong>Bewaar deze code om je aanbieding later te wijzigen of te verwijderen: <span class="code">${code}</span></strong></p>
    <p><a href="/">Terug naar overzicht</a> &middot; <a href="/nieuw">Nog een aanbieding plaatsen</a></p>
  `;
  res.send(layout('Combi-beurs — Geplaatst', body));
});

// manage single offer (mark done / delete) via code
app.get('/aanbieding/:id', (req, res) => {
  const offers = loadOffers();
  const offer = offers.find(o => o.id === req.params.id);
  if (!offer) return res.status(404).send(layout('Niet gevonden', '<p>Aanbieding niet gevonden.</p>'));

  const body = `
    <h1>Aanbieding beheren</h1>
    <p>${esc(locatie(offer.van_land, offer.van_postcode, offer.van_plaats))} &rarr; ${esc(locatie(offer.naar_land, offer.naar_postcode, offer.naar_plaats))} &mdash; laden ${esc(offer.laaddatum_van)}, lossen ${esc(offer.losdatum_van)} &mdash; ${esc(offer.bedrijf)}</p>
    <form method="post" action="/aanbieding/${offer.id}/status">
      <label>Code (ontvangen bij plaatsen)</label>
      <input type="text" name="code" required>
      <div style="margin-top:12px;">
        <button type="submit" name="actie" value="vervuld">Markeer als afgehandeld</button>
        <button type="submit" name="actie" value="verwijderen">Verwijderen</button>
      </div>
    </form>
  `;
  res.send(layout('Combi-beurs — Beheren', body));
});

app.post('/aanbieding/:id/status', (req, res) => {
  let offers = loadOffers();
  const offer = offers.find(o => o.id === req.params.id);
  if (!offer || req.body.code !== offer.code) {
    return res.status(403).send(layout('Foutieve code', '<p>Code klopt niet. <a href="javascript:history.back()">Terug</a></p>'));
  }
  if (req.body.actie === 'verwijderen') {
    offers = offers.filter(o => o.id !== offer.id);
  } else {
    offer.status = 'vervuld';
  }
  saveOffers(offers);
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Combi-beurs draait op http://localhost:${PORT}`);
});
