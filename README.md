# Sint Jut · Het digitale dorpsplein

Astro-website met een live dorpsagenda, ruimteaanvragen, goedkeuring via Telegram en tweerichtingsgebruik met Microsoft 365. De productie-stack bestaat uit Nginx, de agenda-API, een achtergrondwerker en MariaDB.

## Wat de agendafunctie doet

- Iedereen kan openbare activiteiten en de beschikbaarheid per ruimte bekijken.
- Een bezoeker vraagt zonder account een ruimte aan.
- Cloudflare Turnstile en een serverlimiet beschermen het formulier tegen misbruik.
- Alle ingestelde Telegram-beheerders ontvangen de aanvraag met **Goedkeuren**- en **Afwijzen**-knoppen.
- De eerste geldige beslissing wint. Gelijktijdige goedkeuringen en dubbele boekingen worden in MariaDB geblokkeerd.
- Een goedgekeurde aanvraag verschijnt direct als definitief op de website en wordt daarna naar de gekoppelde Microsoft 365-agenda geschreven.
- Afspraken die in Outlook/Office worden toegevoegd, komen door de periodieke Graph-sync in de websiteagenda. Privéafspraken verschijnen alleen als **Bezet**.

## Uitrollen met Coolify

1. Maak in Coolify een nieuwe resource op basis van deze GitHub-repository.
2. Kies **Docker Compose** en `docker-compose.yml` uit de hoofdmap.
3. Koppel het domein aan service `sintjut`, poort `80`.
4. Neem alle variabelen uit `.env.example` over in Coolify. Gebruik sterke, verschillende databasewachtwoorden.
5. Deploy de stack. De database-tabellen en drie standaardruimtes worden automatisch aangemaakt.
6. Controleer `https://jouwdomein.nl/api/v1/agenda` en de homepage.

Alle publieke API-routes lopen via dezelfde FQDN als de website: `/api/*`
wordt door Nginx doorgestuurd naar de interne service `api:3000`. Publiceer de
`api`-service daarom niet met een eigen domein of poort. Een verzoek aan `/api`
wordt doorgestuurd naar `/api/`, waar een JSON-overzicht van de beschikbare
publieke endpoints staat. De functionele endpoints beginnen bij `/api/v1/`.

De volume `agenda_data` bevat de MariaDB-data en moet persistent blijven. Alleen de Nginx-service hoort publiek bereikbaar te zijn; `api`, `worker` en `mariadb` blijven intern.

## Telegram instellen

1. Maak via **@BotFather** een bot en plaats de token als `TELEGRAM_BOT_TOKEN` in Coolify.
2. Voeg de bot toe aan de beheerdersgroep. Plaats het numerieke groeps-ID in `TELEGRAM_ADMIN_CHAT_ID`.
3. Zet de numerieke user-ID's van alle beslissingsbevoegde beheerders komma-gescheiden in `TELEGRAM_ADMIN_USER_IDS`. Lid zijn van de groep alleen is niet genoeg.
4. Genereer een willekeurige geheime tekenreeks voor `TELEGRAM_WEBHOOK_SECRET`.
5. Registreer na deployment de webhook vanaf een vertrouwde terminal. De bot-token hoort niet in chat, broncode of shellhistorie:

```bash
read -s TELEGRAM_TOKEN
read -s TELEGRAM_SECRET
curl --fail-with-body --request POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook" \
  --data-urlencode "url=https://jouwdomein.nl/webhooks/telegram" \
  --data-urlencode "secret_token=${TELEGRAM_SECRET}" \
  --data-urlencode 'allowed_updates=["callback_query"]'
unset TELEGRAM_TOKEN TELEGRAM_SECRET
```

## Cloudflare Turnstile instellen

Turnstile werkt ook als het domein of DNS niet via Cloudflare loopt.

1. Maak in Cloudflare een Turnstile-widget in **Managed** mode voor het productiedomein.
2. Vul `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` en alleen de hostname (zonder `https://`) in als `TURNSTILE_EXPECTED_HOSTNAME`.
3. Deploy opnieuw. Zodra de secret is ingevuld, weigert de API aanvragen zonder een server-side gevalideerd token.

Laat beide sleutels leeg tijdens lokaal ontwikkelen als Turnstile niet nodig is. Gebruik voor geautomatiseerde tests de officiële testkeys van Cloudflare, nooit de productiesleutels.

## Microsoft 365 instellen

1. Registreer een Entra ID-app met Microsoft Graph application permission `Calendars.ReadWrite` en verleen admin consent.
2. Beperk in Microsoft 365 de app bij voorkeur tot de agenda-mailbox die voor Sint Jut is bedoeld.
3. Vul `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` en `GRAPH_MAILBOX` in.
4. Koppel de agenda-ID per ruimte in `GRAPH_CALENDAR_IDS`, bijvoorbeeld:

```dotenv
GRAPH_CALENDAR_IDS=doarpsfinne=AAMk...AAA=,vergaderruimte=AAMk...BBB=,grote-zaal=AAMk...CCC=
```

De parser splitst bij het eerste `=`-teken, zodat `=` in een agenda-ID geen probleem is. Zet daarna `GRAPH_SYNC_ENABLED=true` en deploy opnieuw. De worker haalt Office-wijzigingen elke vijf minuten op. De webhookroute `/webhooks/microsoft-graph` is voorbereid voor een Graph-subscription, maar periodieke synchronisatie werkt zonder subscription.

## Lokaal ontwikkelen

```bash
corepack enable
pnpm install
pnpm dev
```

Voor de volledige stack: kopieer `.env.example` naar `.env`, vul minimaal de verplichte MariaDB- en Telegramwaarden in en start `docker compose up --build`.

## Belangrijke bestanden

- `src/components/Agenda.astro` — openbare agenda en aanvraagformulier
- `services/api/src/server.js` — API, Turnstile-validatie en Telegram-webhook
- `services/api/src/worker.js` — Telegrammeldingen en Microsoft Graph-sync
- `services/api/migrations/001_initial.sql` — MariaDB-schema
- `docker-compose.yml` — Coolify-productiestack

## Facebook en logo

De startpagina haalt JSON Feed op bij `https://rss.app/feeds/v1.1/WGIxu8P4rGM7qjlZ.json` wanneer de pagina wordt geopend en daarna iedere tien minuten zolang de pagina zichtbaar is. De verversknop controleert direct. RSS.app bepaalt zelf wanneer de bron wordt bijgewerkt. Bij een fout blijft de vorige selectie zichtbaar met een melding; zonder JavaScript blijft de opgeslagen selectie staan. Titel, tekst, datum en HTTPS-links worden als tekst/DOM-elementen verwerkt, nooit als ingesloten feed-HTML. Foto's verdwijnen wanneer ze niet meer beschikbaar zijn.

Het aangeleverde jubileumlogo staat als geoptimaliseerd WebP-bestand in `public/media/dorpsbelang-125jaar.webp` en wordt via `Logo.astro` in de kop en voettekst gebruikt.
