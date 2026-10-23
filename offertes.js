'use strict';
// Offerte-aanvragen: het collectief (beheer) plaatst aanvragen, leden schrijven in met een offerte.
const crypto = require('crypto');

async function migreer(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS offerte_aanvragen (
    id TEXT PRIMARY KEY,
    van_land TEXT, van_postcode TEXT, van_plaats TEXT,
    naar_land TEXT, naar_postcode TEXT, naar_plaats TEXT,
    laaddatum TEXT, losdatum TEXT,
    laadmeter TEXT, hoogte TEXT, gewicht TEXT,
    type_lading TEXT, opmerking TEXT,
    budget TEXT, deadline TEXT,
    openbaar BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'open',
    aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS offerte_reacties (
    id TEXT PRIMARY KEY,
    aanvraag_id TEXT NOT NULL,
    bedrijf_id TEXT NOT NULL,
    prijs TEXT NOT NULL,
    bericht TEXT,
    gekozen BOOLEAN NOT NULL DEFAULT false,
    aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT now(),
    bijgewerkt_op TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (aanvraag_id, bedrijf_id)
  )`);
}

function vandaagNL() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
}

function fmtDatum(d) {
  const p = String(d || '').split('-');
  return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : '-';
}

// "450" of "450,5" wordt "450.50"; ongeldig of 0 wordt null
function parseBedrag(s) {
  const n = parseFloat(String(s || '').trim().replace(/\./g, '').replace(',', '.'));
  if (!isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

function fmtBedrag(p) {
  if (!p) return '-';
  const delen = Number(p).toFixed(2).split('.');
  const hele = delen[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return '&euro; ' + hele + ',' + delen[1];
}

function isGesloten(a) {
  return a.status !== 'open' || (a.deadline && a.deadline < vandaagNL());
}

function statusBadge(a) {
  if (a.status === 'toegekend') return '<span class="badge" style="background:#1a7d3c;">Toegekend</span>';
  if (isGesloten(a)) return '<span class="badge" style="background:var(--grijs);">Gesloten</span>';
  return '<span class="badge badge-vracht">Open</span>';
}

function registreer(app, deps) {
  const { pool, layout, requireLogin, requireAdmin, ah, esc, landOptions, locatie } = deps;

  const melding = (t) => '<p style="background:var(--blauw-licht); border:1px solid var(--rand); padding:10px 14px; border-radius:6px; max-width:860px; margin-bottom:16px;">' + t + '</p>';
  const fout = (t) => '<p style="background:#fdecec; border:1px solid #e3b4b4; color:#7a1f1f; padding:10px 14px; border-radius:6px; max-width:860px; margin-bottom:16px;">' + t + '</p>';
  const regel = (k, v) => '<div style="display:flex; gap:12px; padding:7px 0; border-top:1px solid var(--rand);"><div style="width:150px; flex-shrink:0; color:var(--grijs); font-weight:600; font-size:0.85rem;">' + k + '</div><div style="min-width:0; overflow-wrap:anywhere;">' + v + '</div></div>';

  function routeHtml(a) {
    return locatie(a.van_land, a.van_postcode, a.van_plaats) + '<br>&rarr; ' + locatie(a.naar_land, a.naar_postcode, a.naar_plaats);
  }

  function ladingHtml(a) {
    const delen = [];
    if (a.laadmeter) delen.push(esc(a.laadmeter) + ' ldm');
    if (a.gewicht) delen.push(esc(a.gewicht) + ' t');
    if (a.hoogte) delen.push(esc(a.hoogte) + ' m hoog');
    if (a.type_lading) delen.push(esc(a.type_lading));
    return delen.join('<br>') || '-';
  }

  function detailKaart(a) {
    return '<div class="offer-form" style="margin-bottom:20px;">'
      + '<div style="margin-bottom:10px;">' + statusBadge(a) + '</div>'
      + regel('Route', routeHtml(a))
      + regel('Laden', esc(fmtDatum(a.laaddatum)))
      + regel('Lossen', esc(fmtDatum(a.losdatum)))
      + regel('Laadmeter', a.laadmeter ? esc(a.laadmeter) + ' ldm' : '-')
      + regel('Gewicht', a.gewicht ? esc(a.gewicht) + ' ton' : '-')
      + regel('Hoogte', a.hoogte ? esc(a.hoogte) + ' m' : '-')
      + regel('Lading', esc(a.type_lading || '-'))
      + regel('Opmerking', esc(a.opmerking || '-'))
      + regel('Gewenst budget', a.budget ? fmtBedrag(a.budget) + ' <small style="color:var(--grijs);">(basisprijs, excl. dieseltoeslag en BTW)</small>' : '-')
      + regel('Reageren voor', esc(fmtDatum(a.deadline)))
      + '</div>';
  }

  // ---------- leden ----------
  app.get('/overzicht/offertes', requireLogin, ah(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.*,
         (SELECT COUNT(*) FROM offerte_reacties r WHERE r.aanvraag_id = a.id) AS aantal,
         m.prijs AS mijn_prijs, m.gekozen AS mijn_gekozen
       FROM offerte_aanvragen a
       LEFT JOIN offerte_reacties m ON m.aanvraag_id = a.id AND m.bedrijf_id = $1
       ORDER BY a.deadline ASC, a.aangemaakt_op DESC`, [req.bedrijf.id]);
    const open = rows.filter(a => !isGesloten(a));
    const dicht = rows.filter(a => isGesloten(a));

    const rij = (a) => {
      let actie;
      if (isGesloten(a)) {
        actie = a.mijn_gekozen ? '<strong style="color:#1a7d3c;">Toegekend aan jou</strong><br>' : '';
        actie += '<a href="/offerte/' + esc(a.id) + '">Bekijken</a>';
      } else if (a.mijn_prijs) {
        actie = 'Jouw offerte:<br><strong>' + fmtBedrag(a.mijn_prijs) + '</strong><br><a href="/offerte/' + esc(a.id) + '">Wijzigen</a>';
      } else {
        actie = '<a href="/offerte/' + esc(a.id) + '">Offerte indienen</a>';
      }
      const n = Number(a.aantal);
      return '<tr' + (isGesloten(a) ? ' class="vervuld"' : '') + '>'
        + '<td>' + routeHtml(a) + '</td>'
        + '<td>' + esc(fmtDatum(a.laaddatum)) + '</td>'
        + '<td>' + esc(fmtDatum(a.losdatum)) + '</td>'
        + '<td>' + ladingHtml(a) + '</td>'
        + '<td>' + (a.budget ? fmtBedrag(a.budget) : '-') + '</td>'
        + '<td>' + esc(fmtDatum(a.deadline)) + '</td>'
        + '<td>' + statusBadge(a) + '<br><small style="color:var(--grijs);">' + n + ' ' + (n === 1 ? 'reactie' : 'reacties') + '</small></td>'
        + '<td>' + actie + '</td>'
        + '</tr>';
    };

    const kop = '<colgroup><col style="width:25%"><col style="width:9%"><col style="width:9%"><col style="width:15%"><col style="width:9%"><col style="width:9%"><col style="width:11%"><col style="width:13%"></colgroup>'
      + '<thead><tr><th>Route</th><th>Laden</th><th>Lossen</th><th>Lading</th><th>Budget</th><th>Reageren v&oacute;&oacute;r</th><th>Status</th><th></th></tr></thead>';

    const body = '<h1>Offerte-aanvragen</h1>'
      + '<p class="form-intro">Ritten waar het collectief van CombiMatch een oplossing voor zoekt. Heb je capaciteit die hierbij past, schrijf dan in met je offerte. Je prijs is alleen zichtbaar voor het collectief.</p>'
      + (req.query.ingetrokken === '1' ? melding('Je offerte is ingetrokken.') : '')
      + '<table class="offers">' + kop + '<tbody>' + (open.map(rij).join('') || '<tr><td colspan="8" class="empty">Er staan nu geen open offerte-aanvragen.</td></tr>') + '</tbody></table>'
      + (dicht.length ? '<h2 style="margin-top:32px;">Gesloten aanvragen</h2><table class="offers">' + kop + '<tbody>' + dicht.map(rij).join('') + '</tbody></table>' : '');
    res.send(layout(req, 'Combi-Match - Offerte-aanvragen', body));
  }));

  app.get('/offerte/:id', requireLogin, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM offerte_aanvragen WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).send(layout(req, 'Combi-Match - Niet gevonden', '<h1>Niet gevonden</h1><p><a href="/overzicht/offertes">Terug naar offerte-aanvragen</a></p>'));
    const a = rows[0];
    const { rows: mijn } = await pool.query('SELECT * FROM offerte_reacties WHERE aanvraag_id = $1 AND bedrijf_id = $2', [a.id, req.bedrijf.id]);
    const m = mijn[0];

    let formulier;
    if (isGesloten(a)) {
      formulier = melding(a.status === 'toegekend'
        ? (m && m.gekozen ? 'Deze rit is aan jou toegekend. Het collectief neemt contact met je op.' : 'Deze rit is inmiddels toegekend.')
        : 'Deze aanvraag is gesloten. Reageren is niet meer mogelijk.')
        + (m ? melding('Jouw offerte: <strong>' + fmtBedrag(m.prijs) + '</strong>' + (m.bericht ? '<br>' + esc(m.bericht) : '')) : '');
    } else {
      formulier = '<form class="offer-form" method="post" action="/offerte/' + esc(a.id) + '/reageren">'
        + '<h2 style="margin-bottom:12px;">' + (m ? 'Jouw offerte wijzigen' : 'Offerte indienen') + '</h2>'
        + '<div class="form-row"><label>Jouw prijs in &euro; (basisprijs, excl. dieseltoeslag en BTW)</label>'
        + '<input type="text" name="prijs" inputmode="decimal" required placeholder="bijv. 450" value="' + (m ? esc(Number(m.prijs).toFixed(2).replace('.', ',')) : '') + '"></div>'
        + '<div class="form-row"><label>Bericht (optioneel)</label>'
        + '<textarea name="bericht" rows="4" placeholder="bijv. beschikbare combi, laadtijd, bijzonderheden" style="width:100%; padding:8px; border:1px solid var(--rand); border-radius:5px; font-family:inherit; font-size:0.9rem;">' + (m ? esc(m.bericht || '') : '') + '</textarea></div>'
        + '<p style="font-size:0.8rem; color:var(--grijs); margin-bottom:12px;">Standaardvoorwaarden: prijzen excl. BTW, 2 uur vrij voor laden en lossen. Alleen het collectief ziet jouw prijs.</p>'
        + '<div class="form-row"><button type="submit">' + (m ? 'Offerte wijzigen' : 'Offerte indienen') + '</button></div>'
        + '</form>'
        + (m ? '<form method="post" action="/offerte/' + esc(a.id) + '/intrekken" style="margin-top:10px;" onsubmit="return confirm(\'Je offerte intrekken?\')"><button type="submit" class="link-danger">Offerte intrekken</button></form>' : '');
    }

    const body = '<p><a href="/overzicht/offertes" style="font-size:0.85rem;">&larr; Alle offerte-aanvragen</a></p>'
      + '<h1>Offerte-aanvraag</h1>'
      + (req.query.ok === '1' ? melding('Je offerte is opgeslagen.') : '')
      + (req.query.fout === '1' ? fout('Vul een geldige prijs in, bijvoorbeeld 450 of 450,50.') : '')
      + (req.query.fout === '2' ? fout('Reageren is niet meer mogelijk voor deze aanvraag.') : '')
      + detailKaart(a) + formulier;
    res.send(layout(req, 'Combi-Match - Offerte-aanvraag', body));
  }));

  app.post('/offerte/:id/reageren', requireLogin, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM offerte_aanvragen WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.redirect('/overzicht/offertes');
    const a = rows[0];
    if (isGesloten(a)) return res.redirect('/offerte/' + a.id + '?fout=2');
    const prijs = parseBedrag(req.body.prijs);
    if (!prijs) return res.redirect('/offerte/' + a.id + '?fout=1');
    const bericht = String(req.body.bericht || '').trim().slice(0, 1000);
    await pool.query(
      `INSERT INTO offerte_reacties (id, aanvraag_id, bedrijf_id, prijs, bericht) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (aanvraag_id, bedrijf_id) DO UPDATE SET prijs = EXCLUDED.prijs, bericht = EXCLUDED.bericht, bijgewerkt_op = now()`,
      [crypto.randomUUID(), a.id, req.bedrijf.id, prijs, bericht]);
    res.redirect('/offerte/' + a.id + '?ok=1');
  }));

  app.post('/offerte/:id/intrekken', requireLogin, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM offerte_aanvragen WHERE id = $1', [req.params.id]);
    if (rows.length && !isGesloten(rows[0])) {
      await pool.query('DELETE FROM offerte_reacties WHERE aanvraag_id = $1 AND bedrijf_id = $2', [req.params.id, req.bedrijf.id]);
    }
    res.redirect('/overzicht/offertes?ingetrokken=1');
  }));

  // ---------- beheer (collectief) ----------
  app.get('/admin/offertes', requireAdmin, ah(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.*, (SELECT COUNT(*) FROM offerte_reacties r WHERE r.aanvraag_id = a.id) AS aantal
       FROM offerte_aanvragen a ORDER BY a.aangemaakt_op DESC`);
    const vandaag = vandaagNL();
    const lijst = rows.map(a => '<tr' + (isGesloten(a) ? ' class="vervuld"' : '') + '>'
      + '<td>' + routeHtml(a) + '</td>'
      + '<td>' + esc(fmtDatum(a.laaddatum)) + '</td>'
      + '<td>' + esc(fmtDatum(a.deadline)) + '</td>'
      + '<td>' + (a.openbaar ? 'Openbaar' : 'Besloten') + '</td>'
      + '<td>' + statusBadge(a) + '</td>'
      + '<td>' + Number(a.aantal) + '</td>'
      + '<td><a href="/admin/offertes/' + esc(a.id) + '">Beheren</a></td>'
      + '</tr>').join('');

    const body = '<p><a href="/admin" style="font-size:0.85rem;">&larr; Beheer</a></p>'
      + '<h1>Beheer &ndash; offerte-aanvragen</h1>'
      + '<p class="form-intro">Plaats hier een rit waarvoor het collectief een oplossing zoekt. Leden kunnen erop inschrijven met een offerte.</p>'
      + '<form class="offer-form" method="post" action="/admin/offertes" style="margin-bottom:28px;">'
      + '<div class="form-row two-col"><div><label>Van &ndash; land</label><select name="van_land">' + landOptions('NL', false) + '</select></div>'
      + '<div><label>Van &ndash; postcode</label><input type="text" name="van_postcode" placeholder="bijv. 3011"></div>'
      + '<div><label>Van &ndash; plaats</label><input type="text" name="van_plaats" required placeholder="bijv. Rotterdam"></div></div>'
      + '<div class="form-row two-col"><div><label>Naar &ndash; land</label><select name="naar_land">' + landOptions('DE', false) + '</select></div>'
      + '<div><label>Naar &ndash; postcode</label><input type="text" name="naar_postcode" placeholder="bijv. 10115"></div>'
      + '<div><label>Naar &ndash; plaats</label><input type="text" name="naar_plaats" required placeholder="bijv. Berlijn"></div></div>'
      + '<div class="form-row two-col"><div><label>Laaddatum</label><input type="date" name="laaddatum" required value="' + vandaag + '"></div>'
      + '<div><label>Losdatum</label><input type="date" name="losdatum" required value="' + vandaag + '"></div></div>'
      + '<div class="form-row two-col"><div><label>Laadmeter</label><input type="number" step="any" min="0.4" max="22.5" name="laadmeter" placeholder="bijv. 15.5"></div>'
      + '<div><label>Gewicht (ton)</label><input type="number" step="0.1" min="0" name="gewicht" placeholder="bijv. 12"></div>'
      + '<div><label>Hoogte (m)</label><input type="number" step="0.01" min="0.1" max="3.10" name="hoogte" placeholder="bijv. 3.00"></div></div>'
      + '<div class="form-row two-col"><div><label>Type lading</label><input type="text" name="type_lading" placeholder="bijv. blokpallets"></div>'
      + '<div><label>Opmerking</label><input type="text" name="opmerking" placeholder="bijv. geen stapelen"></div></div>'
      + '<div class="form-row two-col"><div><label>Gewenst budget in &euro; (optioneel, excl. dieseltoeslag en BTW)</label><input type="text" name="budget" inputmode="decimal" placeholder="bijv. 1200"></div>'
      + '<div><label>Reageren voor (deadline)</label><input type="date" name="deadline" required></div></div>'
      + '<div class="form-row"><label style="display:flex; align-items:center; gap:8px; font-weight:400;"><input type="checkbox" name="openbaar" value="1" style="width:auto;"> Ook zichtbaar voor kijkers (openbaar). Zonder vinkje blijft de aanvraag binnen het besloten netwerk van leden.</label>'
      + '<small style="color:var(--grijs);">Kijkersaccounts bestaan nog niet. De keuze wordt alvast opgeslagen.</small></div>'
      + '<div class="form-row"><button type="submit">Offerte-aanvraag plaatsen</button></div>'
      + '</form>'
      + '<table class="offers"><colgroup><col style="width:28%"><col style="width:12%"><col style="width:13%"><col style="width:13%"><col style="width:12%"><col style="width:10%"><col style="width:12%"></colgroup>'
      + '<thead><tr><th>Route</th><th>Laden</th><th>Deadline</th><th>Zichtbaar</th><th>Status</th><th>Reacties</th><th></th></tr></thead>'
      + '<tbody>' + (lijst || '<tr><td colspan="7" class="empty">Nog geen offerte-aanvragen.</td></tr>') + '</tbody></table>';
    res.send(layout(req, 'Combi-Match - Beheer offerte-aanvragen', body));
  }));

  app.post('/admin/offertes', requireAdmin, ah(async (req, res) => {
    const b = req.body;
    const t = (v, max) => String(v || '').trim().slice(0, max || 200);
    const vanPlaats = t(b.van_plaats), naarPlaats = t(b.naar_plaats);
    if (!vanPlaats || !naarPlaats || !b.laaddatum || !b.deadline) return res.redirect('/admin/offertes');
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO offerte_aanvragen (id, van_land, van_postcode, van_plaats, naar_land, naar_postcode, naar_plaats,
         laaddatum, losdatum, laadmeter, hoogte, gewicht, type_lading, opmerking, budget, deadline, openbaar)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, t(b.van_land, 4), t(b.van_postcode, 20), vanPlaats, t(b.naar_land, 4), t(b.naar_postcode, 20), naarPlaats,
       t(b.laaddatum, 10), t(b.losdatum, 10) || t(b.laaddatum, 10), t(b.laadmeter, 10), t(b.hoogte, 10), t(b.gewicht, 10),
       t(b.type_lading), t(b.opmerking, 500), parseBedrag(b.budget) || '', t(b.deadline, 10), b.openbaar === '1']);
    res.redirect('/admin/offertes/' + id);
  }));

  app.get('/admin/offertes/:id', requireAdmin, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM offerte_aanvragen WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.redirect('/admin/offertes');
    const a = rows[0];
    const { rows: reacties } = await pool.query(
      `SELECT r.*, c.naam, c.contactpersoon_naam, c.contactpersoon_telefoon, c.contactpersoon_email
       FROM offerte_reacties r LEFT JOIN companies c ON c.id = r.bedrijf_id
       WHERE r.aanvraag_id = $1 ORDER BY r.prijs::numeric ASC`, [a.id]);

    const rijen = reacties.map(r => {
      const contact = [r.contactpersoon_naam ? esc(r.contactpersoon_naam) : '',
        r.contactpersoon_telefoon ? '<a href="tel:' + esc(r.contactpersoon_telefoon) + '">' + esc(r.contactpersoon_telefoon) + '</a>' : '',
        r.contactpersoon_email ? '<a href="mailto:' + esc(r.contactpersoon_email) + '">' + esc(r.contactpersoon_email) + '</a>' : ''].filter(Boolean).join('<br>');
      return '<tr' + (r.gekozen ? ' style="background:#eaf6ee;"' : '') + '>'
        + '<td><strong>' + esc(r.naam || 'Onbekend bedrijf') + '</strong>' + (r.gekozen ? '<br><span style="color:#1a7d3c; font-weight:600;">Gekozen</span>' : '') + '</td>'
        + '<td><strong>' + fmtBedrag(r.prijs) + '</strong></td>'
        + '<td>' + (esc(r.bericht || '') || '-') + '</td>'
        + '<td>' + (contact || '-') + '</td>'
        + '<td>' + (r.gekozen ? '' : '<form method="post" action="/admin/offertes/' + esc(a.id) + '/toekennen/' + esc(r.id) + '" onsubmit="return confirm(\'Deze rit toekennen aan dit bedrijf?\')"><button type="submit">Toekennen</button></form>') + '</td>'
        + '</tr>';
    }).join('');

    const knoppen = '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px;">'
      + (a.status === 'open'
          ? '<form method="post" action="/admin/offertes/' + esc(a.id) + '/status"><input type="hidden" name="status" value="gesloten"><button type="submit">Aanvraag sluiten</button></form>'
          : '<form method="post" action="/admin/offertes/' + esc(a.id) + '/status"><input type="hidden" name="status" value="open"><button type="submit">Heropenen</button></form>')
      + '<form method="post" action="/admin/offertes/' + esc(a.id) + '/zichtbaarheid"><button type="submit">' + (a.openbaar ? 'Maak besloten (alleen leden)' : 'Maak openbaar (ook kijkers)') + '</button></form>'
      + '<form method="post" action="/admin/offertes/' + esc(a.id) + '/verwijderen" onsubmit="return confirm(\'Deze aanvraag en alle offertes definitief verwijderen?\')"><button type="submit">Verwijderen</button></form>'
      + '</div>';

    const body = '<p><a href="/admin/offertes" style="font-size:0.85rem;">&larr; Alle offerte-aanvragen</a></p>'
      + '<h1>Beheer &ndash; offerte-aanvraag</h1>'
      + '<p class="form-intro">Zichtbaarheid: <strong>' + (a.openbaar ? 'Openbaar (ook kijkers)' : 'Besloten netwerk (alleen leden)') + '</strong></p>'
      + detailKaart(a) + knoppen
      + '<h2 style="margin-bottom:10px;">Offertes (' + reacties.length + ')</h2>'
      + '<table class="offers"><colgroup><col style="width:22%"><col style="width:14%"><col style="width:26%"><col style="width:26%"><col style="width:12%"></colgroup>'
      + '<thead><tr><th>Bedrijf</th><th>Prijs</th><th>Bericht</th><th>Contact</th><th></th></tr></thead>'
      + '<tbody>' + (rijen || '<tr><td colspan="5" class="empty">Nog geen offertes ontvangen.</td></tr>') + '</tbody></table>';
    res.send(layout(req, 'Combi-Match - Beheer offerte-aanvraag', body));
  }));

  app.post('/admin/offertes/:id/status', requireAdmin, ah(async (req, res) => {
    const s = req.body.status === 'open' ? 'open' : 'gesloten';
    await pool.query('UPDATE offerte_aanvragen SET status = $1 WHERE id = $2', [s, req.params.id]);
    if (s === 'open') await pool.query('UPDATE offerte_reacties SET gekozen = false WHERE aanvraag_id = $1', [req.params.id]);
    res.redirect('/admin/offertes/' + req.params.id);
  }));

  app.post('/admin/offertes/:id/zichtbaarheid', requireAdmin, ah(async (req, res) => {
    await pool.query('UPDATE offerte_aanvragen SET openbaar = NOT openbaar WHERE id = $1', [req.params.id]);
    res.redirect('/admin/offertes/' + req.params.id);
  }));

  app.post('/admin/offertes/:id/toekennen/:reactieId', requireAdmin, ah(async (req, res) => {
    await pool.query('UPDATE offerte_reacties SET gekozen = (id = $2) WHERE aanvraag_id = $1', [req.params.id, req.params.reactieId]);
    await pool.query("UPDATE offerte_aanvragen SET status = 'toegekend' WHERE id = $1", [req.params.id]);
    res.redirect('/admin/offertes/' + req.params.id);
  }));

  app.post('/admin/offertes/:id/verwijderen', requireAdmin, ah(async (req, res) => {
    await pool.query('DELETE FROM offerte_reacties WHERE aanvraag_id = $1', [req.params.id]);
    await pool.query('DELETE FROM offerte_aanvragen WHERE id = $1', [req.params.id]);
    res.redirect('/admin/offertes');
  }));
}

module.exports = { migreer, registreer };
