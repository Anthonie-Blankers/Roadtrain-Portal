# Combi-beurs — MVP

Eenvoudige interne vrachtenbeurs voor combi's (14–15,6 laadmeter, 2,60–3,05m hoogte).

## Wat zit erin

- Overzicht van open aanbiedingen met filters op type, route, laaddatum (van–tot), losdatum (van–tot), laadmeter en hoogte
- Formulier om een vracht te zoeken of vrije combi-ruimte aan te bieden, inclusief gewicht (ton)
- Elke aanbieding krijgt een 4-cijferige code waarmee de plaatser 'm later kan afsluiten/verwijderen
- Data wordt opgeslagen in `data/offers.json` (geen database nodig)

## Lokaal draaien (testen op je eigen computer)

Vereist: [Node.js](https://nodejs.org) (versie 18 of hoger).

```
cd combi-beurs
npm install
npm start
```

Ga daarna naar `http://localhost:3000` in je browser.

## Live zetten voor de groep (gratis, ~15 minuten)

Om collega's van andere bedrijven mee te laten doen, moet de app ergens online draaien. Snelste gratis route:

1. Maak een gratis account op [render.com](https://render.com)
2. Zet deze map (`combi-beurs`) in een eigen GitHub-repository (of upload direct als je Render dat laat doen)
3. In Render: **New +** → **Web Service** → koppel de repository
4. Instellingen:
   - Build command: `npm install`
   - Start command: `npm start`
   - Voeg een **Persistent Disk** toe (bijv. 1 GB) gekoppeld aan de map `data/`, zodat aanbiedingen bewaard blijven
5. Klik **Deploy** — je krijgt een openbare URL (bijv. `https://combi-beurs.onrender.com`) die je met de groep kunt delen

Alternatief zonder GitHub: Railway.app werkt vergelijkbaar en kan ook direct vanaf een zip-upload draaien.

## Bekende beperkingen (bewust, voor de MVP)

- Geen inlog/accounts — iedereen met de link kan aanbiedingen plaatsen en zien (geschikt voor een vertrouwde, gesloten groep)
- Geen automatische matching of notificaties — je moet zelf het overzicht checken
- Geen mobiele app, enkel een website (werkt wel prima op een telefoon-browser)

Deze punten staan in het uitbouwpad van het concept-document en kunnen later toegevoegd worden zodra het idee zich bewezen heeft.
