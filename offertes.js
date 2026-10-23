'use strict';
// Offerte-aanvragen: een bedrijf uit het collectief (of het beheer) plaatst een rit die het zelf niet kan rijden,
// andere leden schrijven in met een offerte, de aanvrager kiest.
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
  await pool.query('ALTER TABLE offerte_aanvragen ADD COLUMN IF NOT EXISTS bedrijf_id TEXT');
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

  const AANVRAAG_SQL = `SELECT a.*, ac.naam AS aanvrager_naam, ac.contactpersoon_naam AS aanvrager_contact,
      ac.contactpersoon_telefoon AS aanvrager_telefoon, ac.contactpersoon_email AS aanvrager_email
    FROM offerte_aanvragen a LEFT JOIN companies ac ON ac.id = a.bedrijf_id`;

  async function laadAanvraag(id) {
    const { rows } = await pool.query(AANVRAAG_SQL + ' WHERE a.id = $1', [id]);
    return rows[0] || null;
  }

  function routeHtml(a) {
    return locatie(a.van_land, a.van_postcode, a.van_plaats) + '<br>&rarr; ' + locatie(a.naar_land, a.naar_postcode, a.naar_plaats);
  }

  function doorHtml(a) {
    return '<br><small style="color:var(--grijs);">door ' + esc(a.aanvrager_naam || 'het collectief') + '</small>';
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
      + regel('Aangevraagd door', esc(a.aanvrager_naam || 'Het collectief'))
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
      + regel('Zichtbaar voor', a.openbaar ? 'Openbaar (ook kijkers)' : 'Alleen het collectief')
      + '</div>';
  }

  // formulier om een aanvraag te plaatsen (leden en beheer)
  function aanvraagFormulier(actie, knop) {
    const vandaag = vandaagNL();
    return '<form class="offer-form" method="post" action="' + actie + '" style="margin-bottom:28px;">'
      + '<div class="form-row two-col"><div><label>Van &ndash; land</label><select name="van_land">' + landOptions('NL', false) + '</select></div>'
      + '<div><label>Van &ndash; postcode</label><input type="text" name="van_postcode" placeholder="bijv. 3011"></div>'
      + '<div><label>Van &ndash; plaats</label><input type="text" name="van_plaats" required placeholder="bijv. Rotterdam"></div></div>'
      + '<div class="form-row two-col"><div><label>Naar &ndash; land</label><select name="naar_land">' + landOptions('BE', false) + '</select></div>'
      + '<div><label>Naar &ndash; postcode</label><input type="text" name="naar_postcode" placeholder="bijv. 2000"></div>'
      + '<div><label>Naar &ndash; plaats</label><input type="text" name="naar_plaats" required placeholder="bijv. Antwerpen"></div></div>'
      + '<div class="form-row two-col"><div><label>Laaddatum</label><input type="date" name="laaddatum" required value="' + vandaag + '"></div>'
      + '<div><label>Losdatum</label><input type="date" name="losdatum" required value="' + vandaag + '"></div></div>'
      + '<div class="form-row two-col"><div><label>Laadmeter</label><input type="number" step="any" min="0.4" max="22.5" name="laadmeter" placeholder="bijv. 15.5"></div>'
      + '<div><label>Gewicht (ton)</label><input type="number" step="0.1" min="0" name="gewicht" placeholder="bijv. 12"></div>'
      + '<div><label>Hoogte (m)</label><input type="number" step="0.01" min="0.1" max="3.10" name="hoogte" placeholder="bijv. 3.00"></div></div>'
      + '<div class="form-row two-col"><div><label>Type lading</label><input type="text" name="type_lading" placeholder="bijv. blokpallets"></div>'
      + '<div><label>Opmerking</label><input type="text" name="opmerking" placeholder="bijv. geen stapelen"></div></div>'
      + '<div class="form-row two-col"><div><label>Gewenst budget in &euro; (optioneel, excl. dieseltoeslag en BTW)</label><input type="text" name="budget" inputmode="decimal" placeholder="bijv. 1200"></div>'
      + '<div><label>Reageren voor (deadline)</label><input type="date" name="deadline" required></div></div>'
      + '<div class="form-row"><label style="display:flex; align-items:center; gap:8px; font-weight:400;"><input type="checkbox" name="openbaar" value="1" style="width:auto;"> Ook zichtbaar voor kijkers (openbaar). Zonder vinkje blijft de aanvraag alleen zichtbaar binnen het collectief.</label>'
      + '<small style="color:var(--grijs);">Kijkersaccounts bestaan nog niet. De keuze wordt alvast opgeslagen.</small></div>'
      + '<div class="form-row"><button type="submit">' + knop + '</button></div>'
      + '</form>';
  }

  async function maakAanvraag(b, bedrijfId) {
    const t = (v, max) => String(v || '').trim().slice(0, max || 200);
    const vanPlaats = t(b.van_plaats), naarPlaats = t(b.naar_plaats);
    if (!vanPlaats || !naarPlaats || !b.laaddatum || !b.deadline) return null;
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO offerte_aanvragen (id, van_land, van_postcode, van_plaats, naar_land, naar_postcode, naar_plaats,
         laaddatum, losdatum, laadmeter, hoogte, gewicht, type_lading, opmerking, budget, deadline, openbaar, bedrijf_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, t(b.van_land, 4), t(b.van_postcode, 20), vanPlaats, t(b.naar_land, 4), t(b.naar_postcode, 20), naarPlaats,
       t(b.laaddatum, 10), t(b.losdatum, 10) || t(b.laaddatum, 10), t(b.laadmeter, 10), t(b.hoogte, 10), t(b.gewicht, 10),
       t(b.type_lading), t(b.opmerking, 500), parseBedrag(b.budget) || '', t(b.deadline, 10), b.openbaar === '1', bedrijfId || null]);
    return id;
  }

  // offertes bij een aanvraag, zichtbaar voor de aanvrager en het beheer
  async function reactiesBlok(a, basis) {
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
        + '<td>' + (r.gekozen ? '' : '<form method="post" action="' + basis + '/' + esc(a.id) + '/toekennen/' + esc(r.id) + '" onsubmit="return confirm(\'Deze rit toekennen aan dit bedrijf?\')"><button type="submit">Toekennen</button></form>') + '</td>'
        + '</tr>';
    }).join('');
    return '<h2 style="margin-bottom:10px;">Offertes (' + reacties.length + ')</h2>'
      + '<table class="offers"><colgroup><col style="width:22%"><col style="width:14%"><col style="width:26%"><col style="width:26%"><col style="width:12%"></colgroup>'
      + '<thead><tr><th>Bedrijf</th><th>Prijs</th><th>Bericht</th><th>Contact</th><th></th></tr></thead>'
      + '<tbody>' + (rijen || '<tr><td colspan="5" class="empty">Nog geen offertes ontvangen.</td></tr>') + '</tbody></table>';
  }

  function beheerKnoppen(a, basis) {
    return '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px;">'
      + (a.status === 'open'
          ? '<form method="post" action="' + basis + '/' + esc(a.id) + '/status"><input type="hidden" name="status" value="gesloten"><button type="submit">Aanvraag sluiten</button></form>'
          : '<form method="post" action="' + basis + '/' + esc(a.id) + '/status"><input type="hidden" name="status" value="open"><button type="submit">Heropenen</button></form>')
      + '<form method="post" action="' + basis + '/' + esc(a.id) + '/zichtbaarheid"><button type="submit">' + (a.openbaar ? 'Maak alleen zichtbaar voor collectief' : 'Maak openbaar (ook kijkers)') + '</button></form>'
      + '<form method="post" action="' + basis + '/' + esc(a.id) + '/verwijderen" onsubmit="return confirm(\'Deze aanvraag en alle offertes definitief verwijderen?\')"><button type="submit">Verwijderen</button></form>'
      + '</div>';
  }

  // beheerpagina van een aanvraag (voor de aanvrager zelf en voor het beheer)
  async function beheerPagina(req, res, a, basis, terug, terugTekst, titel) {
    const body = '<p><a href="' + terug + '" style="font-size:0.85rem;">&larr; ' + terugTekst + '</a></p>'
      + '<h1>' + titel + '</h1>'
      + (req.query.nieuw === '1' ? melding('Je offerte-aanvraag is geplaatst. Leden uit het collectief kunnen nu inschrijven.') : '')
      + detailKaart(a) + beheerKnoppen(a, basis) + await reactiesBlok(a, basis);
    res.send(layout(req, 'Combi-Match - ' + titel.replace(/&ndash;/g, '-'), body));
  }

  // routes om een aanvraag te beheren: gedeeld door de aanvrager (/offerte) en het beheer (/admin/offertes)
  function beheerRoutes(basis, guards, terug) {
    app.post(basis + '/:id/status', ...guards, ah(async (req, res) => {
      const s = req.body.status === 'open' ? 'open' : 'gesloten';
      await pool.query('UPDATE offerte_aanvragen SET status = $1 WHERE id = $2', [s, req.aanvraag.id]);
      if (s === 'open') await pool.query('UPDATE offerte_reacties SET gekozen = false WHERE aanvraag_id = $1', [req.aanvraag.id]);
      res.redirect(basis + '/' + req.aanvraag.id);
    }));
    app.post(basis + '/:id/zichtbaarheid', ...guards, ah(async (req, res) => {
      await pool.query('UPDATE offerte_aanvragen SET openbaar = NOT openbaar WHERE id = $1', [req.aanvraag.id]);
      res.redirect(basis + '/' + req.aanvraag.id);
    }));
    app.post(basis + '/:id/toekennen/:reactieId', ...guards, ah(async (req, res) => {
      await pool.query('UPDATE offerte_reacties SET gekozen = (id = $2) WHERE aanvraag_id = $1', [req.aanvraag.id, req.params.reactieId]);
      await pool.query("UPDATE offerte_aanvragen SET status = 'toegekend' WHERE id = $1", [req.aanvraag.id]);
      res.redirect(basis + '/' + req.aanvraag.id);
    }));
    app.post(basis + '/:id/verwijderen', ...guards, ah(async (req, res) => {
      await pool.query('DELETE FROM offerte_reacties WHERE aanvraag_id = $1', [req.aanvraag.id]);
      await pool.query('DELETE FROM offerte_aanvragen WHERE id = $1', [req.aanvraag.id]);
      res.redirect(terug);
    }));
  }

  // ---------- leden ----------
  app.get('/overzicht/offertes', requireLogin, ah(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.*, ac.naam AS aanvrager_naam,
         (SELECT COUNT(*) FROM offerte_reacties r WHERE r.aanvraag_id = a.id) AS aantal,
         m.prijs AS mijn_prijs, m.gekozen AS mijn_gekozen
       FROM offerte_aanvragen a
       LEFT JOIN companies ac ON ac.id = a.bedrijf_id
       LEFT JOIN offerte_reacties m ON m.aanvraag_id = a.id AND m.bedrijf_id = $1
       ORDER BY a.deadline ASC, a.aangemaakt_op DESC`, [req.bedrijf.id]);
    const open = rows.filter(a => !isGesloten(a));
    const dicht = rows.filter(a => isGesloten(a));

    const rij = (a) => {
      let actie;
      if (a.bedrijf_id === req.bedrijf.id) {
        actie = '<strong>Jouw aanvraag</strong><br><a href="/offerte/' + esc(a.id) + '">Beheren</a>';
      } else if (isGesloten(a)) {
        actie = a.mijn_gekozen ? '<strong style="color:#1a7d3c;">Toegekend aan jou</strong><br>' : '';
        actie += '<a href="/offerte/' + esc(a.id) + '">Bekijken</a>';
      } else if (a.mijn_prijs) {
        actie = 'Jouw offerte:<br><strong>' + fmtBedrag(a.mijn_prijs) + '</strong><br><a href="/offerte/' + esc(a.id) + '">Wijzigen</a>';
      } else {
        actie = '<a href="/offerte/' + esc(a.id) + '">Offerte indienen</a>';
      }
      const n = Number(a.aantal);
      return '<tr' + (isGesloten(a) ? ' class="vervuld"' : '') + '>'
        + '<td>' + routeHtml(a) + doorHtml(a) + '</td>'
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
      + '<p class="form-intro">Bedrijven uit het collectief plaatsen hier ritten die ze zelf niet kunnen rijden. Past een rit bij jouw capaciteit, schrijf dan in met je offerte. De aanvrager kiest daarna wie de rit krijgt. Je prijs is alleen zichtbaar voor de aanvrager.</p>'
      + '<p style="margin-bottom:16px;"><a class="link-btn-outline" href="/overzicht/offertes/nieuw">+ Offerte-aanvraag plaatsen</a></p>'
      + (req.query.ingetrokken === '1' ? melding('Je offerte is ingetrokken.') : '')
      + (req.query.verwijderd === '1' ? melding('Je offerte-aanvraag is verwijderd.') : '')
      + '<table class="offers">' + kop + '<tbody>' + (open.map(rij).join('') || '<tr><td colspan="8" class="empty">Er staan nu geen open offerte-aanvragen.</td></tr>') + '</tbody></table>'
      + (dicht.length ? '<h2 style="margin-top:32px;">Gesloten aanvragen</h2><table class="offers">' + kop + '<tbody>' + dicht.map(rij).join('') + '</tbody></table>' : '');
    res.send(layout(req, 'Combi-Match - Offerte-aanvragen', body));
  }));

  app.get('/overzicht/offertes/nieuw', requireLogin, (req, res) => {
    const body = '<p><a href="/overzicht/offertes" style="font-size:0.85rem;">&larr; Alle offerte-aanvragen</a></p>'
      + '<h1>Offerte-aanvraag plaatsen</h1>'
      + '<p class="form-intro">Heb je een rit die niet in jouw regio of capaciteit past? Zet hem hier neer. Andere bedrijven uit het collectief kunnen dan een offerte uitbrengen en jij kiest wie de rit krijgt.</p>'
      + (req.query.fout === '1' ? fout('Vul minstens plaats van laden, plaats van lossen, laaddatum en reactiedeadline in.') : '')
      + aanvraagFormulier('/overzicht/offertes/nieuw', 'Offerte-aanvraag plaatsen');
    res.send(layout(req, 'Combi-Match - Offerte-aanvraag plaatsen', body));
  });

  app.post('/overzicht/offertes/nieuw', requireLogin, ah(async (req, res) => {
    const id = await maakAanvraag(req.body, req.bedrijf.id);
    if (!id) return res.redirect('/overzicht/offertes/nieuw?fout=1');
    res.redirect('/offerte/' + id + '?nieuw=1');
  }));

  app.get('/offerte/:id', requireLogin, ah(async (req, res) => {
    const a = await laadAanvraag(req.params.id);
    if (!a) return res.status(404).send(layout(req, 'Combi-Match - Niet gevonden', '<h1>Niet gevonden</h1><p><a href="/overzicht/offertes">Terug naar offerte-aanvragen</a></p>'));
    if (a.bedrijf_id === req.bedrijf.id) {
      return beheerPagina(req, res, a, '/offerte', '/overzicht/offertes', 'Alle offerte-aanvragen', 'Jouw offerte-aanvraag');
    }
    const { rows: mijn } = await pool.query('SELECT * FROM offerte_reacties WHERE aanvraag_id = $1 AND bedrijf_id = $2', [a.id, req.bedrijf.id]);
    const m = mijn[0];

    let formulier;
    if (isGesloten(a)) {
      const gekozen = m && m.gekozen;
      const contact = gekozen
        ? (a.aanvrager_naam
            ? '<br><br><strong>Contact aanvrager</strong><br>' + [esc(a.aanvrager_naam), esc(a.aanvrager_contact || ''),
                a.aanvrager_telefoon ? '<a href="tel:' + esc(a.aanvrager_telefoon) + '">' + esc(a.aanvrager_telefoon) + '</a>' : '',
                a.aanvrager_email ? '<a href="mailto:' + esc(a.aanvrager_email) + '">' + esc(a.aanvrager_email) + '</a>' : ''].filter(Boolean).join('<br>')
            : '<br>Het collectief neemt contact met je op.')
        : '';
      formulier = melding(a.status === 'toegekend'
        ? (gekozen ? 'Deze rit is aan jou toegekend.' + contact : 'Deze rit is inmiddels toegekend.')
        : 'Deze aanvraag is gesloten. Reageren is niet meer mogelijk.')
        + (m ? melding('Jouw offerte: <strong>' + fmtBedrag(m.prijs) + '</strong>' + (m.bericht ? '<br>' + esc(m.bericht) : '')) : '');
    } else {
      formulier = '<form class="offer-form" method="post" action="/offerte/' + esc(a.id) + '/reageren">'
        + '<h2 style="margin-bottom:12px;">' + (m ? 'Jouw offerte wijzigen' : 'Offerte indienen') + '</h2>'
        + '<div class="form-row"><label>Jouw prijs in &euro; (basisprijs, excl. dieseltoeslag en BTW)</label>'
        + '<input type="text" name="prijs" inputmode="decimal" required placeholder="bijv. 450" value="' + (m ? esc(Number(m.prijs).toFixed(2).replace('.', ',')) : '') + '"></div>'
        + '<div class="form-row"><label>Bericht (optioneel)</label>'
        + '<textarea name="bericht" rows="4" placeholder="bijv. beschikbare combi, laadtijd, bijzonderheden" style="width:100%; padding:8px; border:1px solid var(--rand); border-radius:5px; font-family:inherit; font-size:0.9rem;">' + (m ? esc(m.bericht || '') : '') + '</textarea></div>'
        + '<p style="font-size:0.8rem; color:var(--grijs); margin-bottom:12px;">Standaardvoorwaarden: prijzen excl. BTW, 2 uur vrij voor laden en lossen. Alleen de aanvrager ziet jouw prijs.</p>'
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
    const a = await laadAanvraag(req.params.id);
    if (!a || a.bedrijf_id === req.bedrijf.id) return res.redirect('/overzicht/offertes');
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
    const a = await laadAanvraag(req.params.id);
    if (a && !isGesloten(a)) {
      await pool.query('DELETE FROM offerte_reacties WHERE aanvraag_id = $1 AND bedrijf_id = $2', [a.id, req.bedrijf.id]);
    }
    res.redirect('/overzicht/offertes?ingetrokken=1');
  }));

  // acties van de aanvrager op de eigen aanvraag
  const eigenaarGuard = ah(async (req, res, next) => {
    const a = await laadAanvraag(req.params.id);
    if (!a || a.bedrijf_id !== req.bedrijf.id) return res.redirect('/overzicht/offertes');
    req.aanvraag = a;
    next();
  });
  beheerRoutes('/offerte', [requireLogin, eigenaarGuard], '/overzicht/offertes?verwijderd=1');

  // ---------- beheer (collectief) ----------
  app.get('/admin/offertes', requireAdmin, ah(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.*, ac.naam AS aanvrager_naam, (SELECT COUNT(*) FROM offerte_reacties r WHERE r.aanvraag_id = a.id) AS aantal
       FROM offerte_aanvragen a LEFT JOIN companies ac ON ac.id = a.bedrijf_id ORDER BY a.aangemaakt_op DESC`);
    const lijst = rows.map(a => '<tr' + (isGesloten(a) ? ' class="vervuld"' : '') + '>'
      + '<td>' + routeHtml(a) + doorHtml(a) + '</td>'
      + '<td>' + esc(fmtDatum(a.laaddatum)) + '</td>'
      + '<td>' + esc(fmtDatum(a.deadline)) + '</td>'
      + '<td>' + (a.openbaar ? 'Openbaar' : 'Collectief') + '</td>'
      + '<td>' + statusBadge(a) + '</td>'
      + '<td>' + Number(a.aantal) + '</td>'
      + '<td><a href="/admin/offertes/' + esc(a.id) + '">Beheren</a></td>'
      + '</tr>').join('');

    const body = '<p><a href="/admin" style="font-size:0.85rem;">&larr; Beheer</a></p>'
      + '<h1>Beheer &ndash; offerte-aanvragen</h1>'
      + '<p class="form-intro">Alle offerte-aanvragen van het collectief. Leden plaatsen die zelf; hier kun je ook zelf een aanvraag plaatsen namens het collectief, of aanvragen controleren en verwijderen.</p>'
      + aanvraagFormulier('/admin/offertes', 'Offerte-aanvraag plaatsen')
      + '<table class="offers"><colgroup><col style="width:28%"><col style="width:12%"><col style="width:13%"><col style="width:13%"><col style="width:12%"><col style="width:10%"><col style="width:12%"></colgroup>'
      + '<thead><tr><th>Route</th><th>Laden</th><th>Deadline</th><th>Zichtbaar</th><th>Status</th><th>Reacties</th><th></th></tr></thead>'
      + '<tbody>' + (lijst || '<tr><td colspan="7" class="empty">Nog geen offerte-aanvragen.</td></tr>') + '</tbody></table>';
    res.send(layout(req, 'Combi-Match - Beheer offerte-aanvragen', body));
  }));

  app.post('/admin/offertes', requireAdmin, ah(async (req, res) => {
    const id = await maakAanvraag(req.body, null);
    res.redirect(id ? '/admin/offertes/' + id : '/admin/offertes');
  }));

  app.get('/admin/offertes/:id', requireAdmin, ah(async (req, res) => {
    const a = await laadAanvraag(req.params.id);
    if (!a) return res.redirect('/admin/offertes');
    return beheerPagina(req, res, a, '/admin/offertes', '/admin/offertes', 'Alle offerte-aanvragen', 'Beheer &ndash; offerte-aanvraag');
  }));

  const adminGuard = ah(async (req, res, next) => {
    const a = await laadAanvraag(req.params.id);
    if (!a) return res.redirect('/admin/offertes');
    req.aanvraag = a;
    next();
  });
  beheerRoutes('/admin/offertes', [requireAdmin, adminGuard], '/admin/offertes');
}

module.exports = { migreer, registreer };
