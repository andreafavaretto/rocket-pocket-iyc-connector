# Rocket Pocket IYC Catalog Connector

Backend service that syncs products from a Google Sheet into Shopify every 30 minutes.

## Features

- Reads catalog rows and prices from Google Sheets CSV export.
- Extracts product images anchored in column B from Google Sheets XLSX export.
- Upserts products into Shopify with vendor set to IYC.
- Applies configurable markup percentage to synced prices.
- Runs scheduled sync every 30 minutes (configurable via cron).
- Exposes backend API to manage markup percentage and trigger manual sync.

## Endpoints

- `GET /health`
- `GET /api/settings/markup-percent`
- `PUT /api/settings/markup-percent`
- `POST /api/sync`

## Auth

Use header `x-api-key` for all `/api/*` routes.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill Shopify credentials and store domain.
3. Install dependencies:

   npm install

4. Start service:

   npm start

## Deploy On Railway

This project can run 24/7 on Railway and keep app state between deploys.

1. Create a new Railway project from this repository.
2. Add environment variables from `.env.example`.
3. Add a persistent volume in Railway and mount it at `/app-data`.
4. Set `DATA_DIR=/app-data` in Railway variables.
5. Deploy the service.

After the first Railway deploy, configure Shopify app URLs:

1. Copy your public Railway domain, for example `https://your-app.up.railway.app`.
2. Update `shopify.app.toml`:
   - `application_url = "https://your-app.up.railway.app"`
   - `redirect_urls = [ "https://your-app.up.railway.app/auth/callback" ]`
3. Release the new app config:

   nvm use 22 && shopify app deploy --force

Then open the app in Shopify Admin and click `Connetti Shopify` once to complete OAuth.

## Shopify CLI (`shopify dev`)

This folder now includes:

- `shopify.app.toml`
- `shopify.web.toml`

Before running Shopify CLI, update these placeholders in `shopify.app.toml`:

- `client_id`
- `dev_store_url`
- `application_url` and `redirect_urls` (if needed)

Then run:

```bash
shopify app config link
shopify dev
```

If you only want to run the sync backend without Shopify tunnel/dev session, use:

```bash
npm start
```

## Markup API Example

Request:

PUT /api/settings/markup-percent
Content-Type: application/json
x-api-key: your-key

{
  "markupPercent": 12.5
}

## Notes

- This connector identifies products by deterministic handle generated from product name.
- Product vendor is always forced to `IYC`.
- Prices are sourced from `DEFAULT_PRICE_CURRENCY` and then marked up.
- Image cache is persisted under `data/images`.
- Sync state is persisted in `data/state.json`.
