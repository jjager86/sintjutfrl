# Sint Jut · Het digitale dorpsplein

Astro-website voor Sintjohannesga, Rotsterhaule, Rohel en Vierhuis.

## Uitrollen met Coolify

1. Koppel deze GitHub-repository in Coolify.
2. Kies **Docker Compose** als build pack.
3. Gebruik `docker-compose.yml` uit de hoofdmap.
4. Koppel het gewenste domein aan service `sintjut` op containerpoort `80`.
5. Start de deployment.

De container bouwt de Astro-site en serveert de statische uitvoer via Nginx. De healthcheck controleert de homepage automatisch.

## Lokaal ontwikkelen

```bash
corepack enable
pnpm install
pnpm dev
```

