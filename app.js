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
  <a href="/" class="logo"><img src="/logo.png" alt="CombiMatch" class="logo-img">Combi-Match</a>
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
  <p>CombiMatch &ndash; The Roadtrain Exchange verbindt vervoerders met (volume)combi's van alle types. Via &eacute;&eacute;n platform deel je eenvoudig beschikbare capaciteit, vind je passende vrachten en werk je samen met betrouwbare transportpartners. Zo verhogen we samen de beladingsgraad, beperken we lege kilometers en maken we transport slimmer, duurzamer en rendabeler.</p>
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
  const vanPcs = [q.van_pc1, q.van_pc2, q.van_pc3].map(v => (v || '').trim().toLowerCase()).filter(Boolean);
  const naarPcs = [q.naar_pc1, q.naar_pc2, q.naar_pc3].map(v => (v || '').trim().toLowerCase()).filter(Boolean);
  const laadVanaf = q.laad_vanaf || '';
  const laadTot = q.laad_tot || '';
  const losVanaf = q.los_vanaf || '';
  const losTot = q.los_tot || '';
  const lmMin = q.lm_min !== undefined && q.lm_min !== '' ? parseFloat(q.lm_min) : 13.65;
  const lmMax = q.lm_max !== undefined && q.lm_max !== '' ? parseFloat(q.lm_max) : 16.0;
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

        function periode(van_, tot_) {
          if (!van_) return '-';
          if (!tot_ || tot_ === van_) return esc(van_);
          return `${esc(van_)}<br>&ndash; ${esc(tot_)}`;
        }

        const rows = filtered.map(o => `
        <tr class="${o.status === 'vervuld' ? 'vervuld' : ''}">
        <td><span class="badge badge-${o.type}">${o.type === 'vracht' ? 'Vracht' : 'Combi vrij'}</span></td>
        <td><span class="route-part">${esc(locatie(o.van_land, o.van_postcode, o.van_plaats))}</span> &rarr; <span class="route-part">${esc(locatie(o.naar_land, o.naar_postcode, o.naar_plaats))}</span></td>
        <td>${periode(o.laaddatum_van, o.laaddatum_tot)}</td>
        <td>${periode(o.losdatum_van, o.losdatum_tot)}</td>
        <td>${esc(o.laadmeter)} lm</td>
        <td>${esc(o.hoogte)} m</td>
        <td>${o.gewicht ? esc(o.gewicht) + ' t' : '-'}</td>
        <td>${o.type_lading ? esc(o.type_lading) : '-'}${o.opmerking ? '<br><small>' + esc(o.opmerking) + '</small>' : ''}</td>
        <td>${esc(o.bedrijf)}<br><small>${esc(o.contactpersoon)} &middot; ${esc(o.telefoon)}${o.email ? ' &middot; ' + esc(o.email) : ''}</small></td>
        <td><a href="/aanbieding/${o.id}" class="beheer-link">Beheer</a></td>
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

        res.send(layout('Combi-Match — Overzicht', body));
});

// new offer form
app.get('/nieuw', (req, res) => {
  const body = `
  <h1>Nieuwe aanbieding plaatsen</h1>
  <form class="offer-form" method="post" action="/nieuw">
  <div class="form-row">
  <label>Type aanbieding</label>
  <select name="type" required>
  <option value="vracht">Vracht aanbieden (Ik zoek een vervoerder met een combi)</option>
  <option value="ruimte">Capaciteit aanbieden (Ik heb een combi beschikbaar)</option>
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
  <label>Laadmeter</label>
  <input type="number" step="any" min="13.65" max="16.0" name="laadmeter" required placeholder="bijv. 15.5">
  </div>
  <div>
  <label>Hoogte (m)</label>
  <input type="number" step="0.01" min="0.1" max="3.10" name="hoogte" required placeholder="bijv. 3.00">
  </div>
  </div>
  <div class="form-row two-col">
  <div>
  <label>Type lading</label>
  <input type="text" name="type_lading" placeholder="bijv. blokpallets">
  </div>
  <div>
  <label>Opmerking</label>
  <input type="text" name="opmerking" placeholder="bijv. geen stapelen">
  </div>
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
  res.send(layout('Combi-Match — Nieuwe aanbieding', body));
});

// create offer
app.post('/nieuw', (req, res) => {
  const offers = loadOffers();
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
           geplaatst_op: new Date().toISOString(),
         };

         offers.push(offer);
  saveOffers(offers);

         const body = `
         <h1>Aanbieding geplaatst</h1>
         <p>Je aanbieding staat nu in het overzicht.</p>
         <p><a href="/">Terug naar overzicht</a> &middot; <a href="/nieuw">Nog een aanbieding plaatsen</a></p>
         `;
  res.send(layout('Combi-Match — Geplaatst', body));
});

// manage single offer (mark done / delete)
app.get('/aanbieding/:id', (req, res) => {
    const offers = loadOffers();
    const offer = offers.find(o => o.id === req.params.id);
    if (!offer) return res.status(404).send(layout('Niet gevonden', '<p>Aanbieding niet gevonden.</p>'));

    const opgeslagen = req.query.opgeslagen === '1';

    const body = `
            <h1>Aanbieding bewerken</h1>
                    ${opgeslagen ? '<p style="color:#0b3d63;font-weight:600;">Wijzigingen opgeslagen.</p>' : ''}
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
                                                                                                                                                                                                                                                                                                                                                    <input type="date" name="laaddatum_van" required value="${esc(offer.laaddatum_van)}">
                                                                                                                                                                                                                                                                                                                                                            </div>
                                                                                                                                                                                                                                                                                                                                                                    <div>
                                                                                                                                                                                                                                                                                                                                                                            <label>Laaddatum tot (optioneel)</label>
                                                                                                                                                                                                                                                                                                                                                                                    <input type="date" name="laaddatum_tot" value="${esc(offer.laaddatum_tot)}">
                                                                                                                                                                                                                                                                                                                                                                                            </div>
                                                                                                                                                                                                                                                                                                                                                                                                    </div>
                                                                                                                                                                                                                                                                                                                                                                                                            <div class="form-row two-col">
                                                                                                                                                                                                                                                                                                                                                                                                                    <div>
                                                                                                                                                                                                                                                                                                                                                                                                                            <label>Losdatum van</label>
                                                                                                                                                                                                                                                                                                                                                                                                                                    <input type="date" name="losdatum_van" required value="${esc(offer.losdatum_van)}">
                                                                                                                                                                                                                                                                                                                                                                                                                                            </div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                    <div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                            <label>Losdatum tot (optioneel)</label>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                    <input type="date" name="losdatum_tot" value="${esc(offer.losdatum_tot)}">
                                                                                                                                                                                                                                                                                                                                                                                                                                                                            </div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    </div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            <div class="form-row">
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    <label>Gewicht (ton, optioneel)</label>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            <input type="number" step="0.1" min="0" name="gewicht" value="${esc(offer.gewicht)}">
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    </div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            <div class="form-row two-col">
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    <div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            <label>Laadmeter</label>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    <input type="number" step="any" min="13.65" max="16.0" name="laadmeter" required value="${esc(offer.laadmeter)}">
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
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    <button type="submit" name="actie" value="vervuld">Markeer als afgehandeld</button>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            <button type="submit" name="actie" value="verwijderen">Verwijderen</button>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    </form>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            `;
    res.send(layout('Combi-Match — Bewerken', body));
});

app.post('/aanbieding/:id/bewerken', (req, res) => {
    const offers = loadOffers();
    const offer = offers.find(o => o.id === req.params.id);
    if (!offer) return res.status(404).send(layout('Niet gevonden', '<p>Aanbieding niet gevonden. <a href="/">Terug</a></p>'));

    const laaddatumVan = req.body.laaddatum_van || offer.laaddatum_van;
    const losdatumVan = req.body.losdatum_van || offer.losdatum_van;

    offer.type = req.body.type === 'ruimte' ? 'ruimte' : 'vracht';
    offer.van_land = req.body.van_land || '';
    offer.van_postcode = req.body.van_postcode || '';
    offer.van_plaats = req.body.van_plaats || '';
    offer.naar_land = req.body.naar_land || '';
    offer.naar_postcode = req.body.naar_postcode || '';
    offer.naar_plaats = req.body.naar_plaats || '';
    offer.laaddatum_van = laaddatumVan;
    offer.laaddatum_tot = req.body.laaddatum_tot || laaddatumVan;
    offer.losdatum_van = losdatumVan;
    offer.losdatum_tot = req.body.losdatum_tot || losdatumVan;
    offer.laadmeter = req.body.laadmeter || '';
    offer.hoogte = req.body.hoogte || '';
    offer.gewicht = req.body.gewicht || '';
    offer.type_lading = req.body.type_lading || '';
    offer.opmerking = req.body.opmerking || '';
    offer.bedrijf = req.body.bedrijf || '';
    offer.contactpersoon = req.body.contactpersoon || '';
    offer.telefoon = req.body.telefoon || '';
    offer.email = req.body.email || '';

    saveOffers(offers);
    res.redirect(`/aanbieding/${offer.id}?opgeslagen=1`);
});

app.post('/aanbieding/:id/status', (req, res) => {
  let offers = loadOffers();
  const offer = offers.find(o => o.id === req.params.id);
  if (!offer) {
    return res.status(404).send(layout('Niet gevonden', '<p>Aanbieding niet gevonden. <a href="/">Terug</a></p>'));
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
  console.log(`Combi-Match draait op http://localhost:${PORT}`);
});
