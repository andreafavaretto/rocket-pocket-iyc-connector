const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const stateStore = require('./store/stateStore');
const { runCatalogSync } = require('./services/catalogSyncService');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(value) {
  if (!value) {
    return 'Never';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('it-IT');
}

function renderDashboard({ state, flashMessage = '', flashType = 'info' }) {
  const markupPercent = stateStore.getMarkupPercent();
  const installation = stateStore.getShopifyInstallation(config.shopify.storeDomain);
  const hasStoredInstallation = Boolean(installation && installation.adminAccessToken);
  const hasStaticToken = Boolean(config.shopify.adminAccessToken);
  const connectionLabel = hasStoredInstallation
    ? 'Autorizzato via OAuth'
    : hasStaticToken
      ? 'Token statico configurato'
      : 'Da autorizzare';
  const lastSync = state.lastSync || null;
  const products = Object.entries(state.products || {}).map(([handle, product]) => ({
    handle,
    title: product.title || handle,
    shopifyProductId: product.shopifyProductId || '-',
    lastPrice: product.lastPrice || '-',
    sourceCurrency: product.sourceCurrency || '-',
    updatedAt: product.updatedAt || null
  }));

  const productRows = products.length
    ? products
        .sort((left, right) => String(left.title).localeCompare(String(right.title)))
        .map(product => `
          <tr>
            <td>${escapeHtml(product.title)}</td>
            <td><code>${escapeHtml(product.handle)}</code></td>
            <td>${escapeHtml(product.shopifyProductId)}</td>
            <td>${escapeHtml(product.lastPrice)}</td>
            <td>${escapeHtml(product.sourceCurrency)}</td>
            <td>${escapeHtml(formatTimestamp(product.updatedAt))}</td>
          </tr>
        `)
        .join('')
    : `
      <tr>
        <td colspan="6" class="empty">Nessun prodotto sincronizzato ancora.</td>
      </tr>
    `;

  const errorRows = lastSync && Array.isArray(lastSync.errors) && lastSync.errors.length
    ? lastSync.errors
        .map(error => `<li><strong>${escapeHtml(error.productName || 'Unknown product')}:</strong> ${escapeHtml(error.message)}</li>`)
        .join('')
    : '<li>Nessun errore registrato.</li>';

  return `<!doctype html>
  <html lang="it">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>IYC Catalog Connector</title>
      <style>
        :root {
          --bg: #f5f1e8;
          --panel: #fffaf1;
          --ink: #1e241f;
          --muted: #667067;
          --line: #d8cfbe;
          --accent: #1f6f5f;
          --accent-strong: #154d42;
          --warn: #8f3d2e;
          --ok: #1c6b49;
          --shadow: 0 18px 48px rgba(31, 36, 31, 0.08);
        }

        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: Georgia, 'Iowan Old Style', 'Times New Roman', serif;
          color: var(--ink);
          background:
            radial-gradient(circle at top left, rgba(31, 111, 95, 0.14), transparent 28%),
            radial-gradient(circle at top right, rgba(143, 61, 46, 0.10), transparent 22%),
            linear-gradient(180deg, #f8f4eb 0%, var(--bg) 100%);
        }

        .shell {
          max-width: 1240px;
          margin: 0 auto;
          padding: 40px 20px 56px;
        }

        .hero {
          display: grid;
          grid-template-columns: 1.3fr 0.9fr;
          gap: 20px;
          align-items: stretch;
          margin-bottom: 20px;
        }

        .panel {
          background: rgba(255, 250, 241, 0.92);
          backdrop-filter: blur(8px);
          border: 1px solid var(--line);
          border-radius: 24px;
          box-shadow: var(--shadow);
        }

        .hero-main {
          padding: 28px;
        }

        .eyebrow {
          margin: 0 0 10px;
          color: var(--accent);
          font-size: 12px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }

        h1 {
          margin: 0;
          font-size: clamp(2rem, 4vw, 3.8rem);
          line-height: 0.95;
          letter-spacing: -0.04em;
        }

        .lead {
          margin: 16px 0 0;
          max-width: 52ch;
          color: var(--muted);
          font-size: 18px;
          line-height: 1.5;
        }

        .hero-side {
          padding: 24px;
          display: grid;
          gap: 14px;
          align-content: start;
        }

        .metric-label {
          margin: 0 0 4px;
          color: var(--muted);
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }

        .metric-value {
          margin: 0;
          font-size: 28px;
          line-height: 1;
        }

        .flash {
          margin-bottom: 20px;
          padding: 14px 18px;
          border-radius: 16px;
          border: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.72);
        }

        .flash.info { color: var(--accent-strong); }
        .flash.error { color: var(--warn); border-color: rgba(143, 61, 46, 0.28); }
        .flash.success { color: var(--ok); border-color: rgba(28, 107, 73, 0.28); }

        .grid {
          display: grid;
          grid-template-columns: 380px minmax(0, 1fr);
          gap: 20px;
        }

        .stack {
          display: grid;
          gap: 20px;
        }

        .card {
          padding: 24px;
        }

        .card h2 {
          margin: 0 0 14px;
          font-size: 24px;
        }

        .card p,
        .card li,
        .card label {
          color: var(--muted);
          line-height: 1.5;
        }

        form {
          display: grid;
          gap: 14px;
        }

        input[type="number"] {
          width: 100%;
          padding: 14px 16px;
          border-radius: 14px;
          border: 1px solid var(--line);
          background: #fff;
          font: inherit;
          color: var(--ink);
        }

        button {
          appearance: none;
          border: 0;
          border-radius: 999px;
          padding: 14px 18px;
          background: var(--accent);
          color: #f6f1e8;
          font: inherit;
          font-weight: 700;
          cursor: pointer;
        }

        button.secondary {
          background: #efe6d4;
          color: var(--ink);
        }

        .table-wrap {
          overflow-x: auto;
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        th, td {
          padding: 14px 12px;
          border-bottom: 1px solid var(--line);
          text-align: left;
          vertical-align: top;
          white-space: nowrap;
        }

        th {
          color: var(--muted);
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        code {
          font-family: 'SFMono-Regular', Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
        }

        .empty {
          color: var(--muted);
          text-align: center;
          padding: 28px;
        }

        ul {
          margin: 0;
          padding-left: 18px;
        }

        @media (max-width: 960px) {
          .hero,
          .grid {
            grid-template-columns: 1fr;
          }
        }
      </style>
    </head>
    <body>
      <main class="shell">
        ${flashMessage ? `<div class="flash ${escapeHtml(flashType)}">${escapeHtml(flashMessage)}</div>` : ''}
        <section class="hero">
          <article class="panel hero-main">
            <p class="eyebrow">Rocket Pocket x IYC</p>
            <h1>Catalog connector con sync manuale e marginalità.</h1>
            <p class="lead">Questa app ora usa il backend del progetto come dashboard operativa. Da qui puoi forzare il sync del catalogo Google Sheets verso Shopify, aggiornare la marginalità percentuale e controllare gli ultimi prodotti sincronizzati.</p>
          </article>
          <aside class="panel hero-side">
            <div>
              <p class="metric-label">Store Shopify</p>
              <p class="metric-value">${escapeHtml(config.shopify.storeDomain)}</p>
            </div>
            <div>
              <p class="metric-label">Connessione Shopify</p>
              <p class="metric-value">${escapeHtml(connectionLabel)}</p>
            </div>
            <div>
              <p class="metric-label">Ultimo sync</p>
              <p class="metric-value">${escapeHtml(formatTimestamp(lastSync && lastSync.finishedAt))}</p>
            </div>
            <div>
              <p class="metric-label">Prodotti in stato locale</p>
              <p class="metric-value">${products.length}</p>
            </div>
          </aside>
        </section>

        <section class="grid">
          <div class="stack">
            <article class="panel card">
              <h2>Autorizzazione Shopify</h2>
              <p>Stato attuale: <strong>${hasStoredInstallation ? 'autorizzato via OAuth' : 'non autorizzato via OAuth'}</strong>.</p>
              <p>${installation ? `Token OAuth aggiornato il ${escapeHtml(formatTimestamp(installation.updatedAt))}.` : 'Serve un passaggio OAuth per ottenere il token offline dello store.'}</p>
              <p>${hasStaticToken ? 'E presente anche un token statico nel file .env, ma il sync usera il token OAuth salvato appena disponibile.' : 'Nessun token statico configurato nel file .env.'}</p>
              <form method="get" action="/auth/start">
                <button type="submit" class="${hasStoredInstallation ? 'secondary' : ''}">${hasStoredInstallation ? 'Riconnetti Shopify' : 'Connetti Shopify'}</button>
              </form>
            </article>

            <article class="panel card">
              <h2>Marginalità</h2>
              <form method="post" action="/app/settings/markup-percent">
                <label for="markupPercent">Percentuale da applicare ai prezzi importati</label>
                <input id="markupPercent" name="markupPercent" type="number" min="0" step="0.01" value="${escapeHtml(markupPercent)}" />
                <button type="submit">Salva marginalità</button>
              </form>
            </article>

            <article class="panel card">
              <h2>Sync manuale</h2>
              <p>Usa questo comando per forzare subito il caricamento del catalogo dal Google Sheet e aggiornare i prodotti su Shopify.</p>
              <form method="post" action="/app/sync">
                <button type="submit">Avvia sync adesso</button>
              </form>
            </article>

            <article class="panel card">
              <h2>Ultimo report</h2>
              <p><strong>Scansionati:</strong> ${lastSync ? lastSync.scanned : 0}</p>
              <p><strong>Sincronizzati:</strong> ${lastSync ? lastSync.synced : 0}</p>
              <p><strong>Saltati:</strong> ${lastSync ? lastSync.skipped : 0}</p>
              <p><strong>Errori:</strong> ${lastSync && Array.isArray(lastSync.errors) ? lastSync.errors.length : 0}</p>
              <ul>${errorRows}</ul>
            </article>
          </div>

          <article class="panel card">
            <h2>Prodotti sincronizzati</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Titolo</th>
                    <th>Handle</th>
                    <th>ID Shopify</th>
                    <th>Prezzo</th>
                    <th>Valuta</th>
                    <th>Aggiornato</th>
                  </tr>
                </thead>
                <tbody>${productRows}</tbody>
              </table>
            </div>
          </article>
        </section>
      </main>
    </body>
  </html>`;
}

function redirectWithMessage(res, type, message) {
  const params = new URLSearchParams({ type, message });
  res.redirect(`/?${params.toString()}`);
}

function isValidShopDomain(value) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(String(value || '').trim());
}

function buildAppBaseUrl(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function buildOAuthRedirectUri(req) {
  return `${buildAppBaseUrl(req)}/auth/callback`;
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) {
        return acc;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function buildShopifyAuthMessage(query) {
  const pairs = Object.keys(query)
    .filter(key => key !== 'hmac' && key !== 'signature')
    .sort()
    .map(key => `${key}=${Array.isArray(query[key]) ? query[key].join(',') : query[key]}`);
  return pairs.join('&');
}

function validateShopifyHmac(query) {
  const providedHmac = String(query.hmac || '');
  if (!providedHmac || !config.shopify.clientSecret) {
    return false;
  }

  const generatedHmac = crypto
    .createHmac('sha256', config.shopify.clientSecret)
    .update(buildShopifyAuthMessage(query))
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(providedHmac, 'utf8'), Buffer.from(generatedHmac, 'utf8'));
  } catch (_error) {
    return false;
  }
}

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== config.server.backendApiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get(['/', '/app'], (req, res) => {
  try {
    const state = stateStore.readState();
    const flashMessage = typeof req.query.message === 'string' ? req.query.message : '';
    const flashType = typeof req.query.type === 'string' ? req.query.type : 'info';
    res.type('html').send(renderDashboard({ state, flashMessage, flashType }));
  } catch (error) {
    console.error('[HTTP] GET / error:', error.message);
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
});

app.get('/auth/start', (req, res) => {
  const shop = String(req.query.shop || config.shopify.storeDomain || '').trim();
  if (!isValidShopDomain(shop)) {
    redirectWithMessage(res, 'error', 'Shop Shopify non valido per l\'autorizzazione.');
    return;
  }

  if (!config.shopify.clientId || !config.shopify.clientSecret) {
    redirectWithMessage(res, 'error', 'Mancano SHOPIFY_API_KEY o SHOPIFY_API_SECRET nel file .env.');
    return;
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  stateStore.createPendingOAuthState(nonce, shop);

  // Fallback for environments where filesystem state can be racy.
  res.setHeader('Set-Cookie', `oauth_state=${encodeURIComponent(nonce)}; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax`);

  const params = new URLSearchParams({
    client_id: config.shopify.clientId,
    scope: config.shopify.accessScopes,
    redirect_uri: buildOAuthRedirectUri(req),
    state: nonce
  });

  res.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  const shop = String(req.query.shop || '').trim();
  const code = String(req.query.code || '').trim();
  const nonce = String(req.query.state || '').trim();
  const cookies = parseCookies(req.headers.cookie || '');
  const nonceFromCookie = String(cookies.oauth_state || '').trim();

  if (!isValidShopDomain(shop) || !code || !nonce) {
    redirectWithMessage(res, 'error', 'Callback Shopify incompleto o non valido.');
    return;
  }

  if (!validateShopifyHmac(req.query)) {
    redirectWithMessage(res, 'error', 'Validazione HMAC Shopify fallita.');
    return;
  }

  const pendingState = stateStore.consumePendingOAuthState(nonce);
  const hasValidStateFromStore = Boolean(pendingState && pendingState.shopDomain === shop);
  const hasValidStateFromCookie = Boolean(nonceFromCookie && nonceFromCookie === nonce);
  if (!hasValidStateFromStore && !hasValidStateFromCookie) {
    redirectWithMessage(res, 'error', 'Stato OAuth Shopify non valido o scaduto.');
    return;
  }

  // Clear oauth state cookie after successful validation.
  res.setHeader('Set-Cookie', 'oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: config.shopify.clientId,
        client_secret: config.shopify.clientSecret,
        code
      })
    });

    const payload = await response.json();
    if (!response.ok || !payload.access_token) {
      throw new Error(payload.error_description || payload.error || JSON.stringify(payload));
    }

    stateStore.setShopifyInstallation(shop, {
      adminAccessToken: payload.access_token,
      scope: payload.scope || config.shopify.accessScopes,
      installedAt: new Date().toISOString()
    });

    redirectWithMessage(res, 'success', 'Store Shopify autorizzato correttamente. Ora puoi lanciare il sync.');
  } catch (error) {
    redirectWithMessage(res, 'error', `Autorizzazione Shopify fallita: ${error.message}`);
  }
});

app.get('/health', (_req, res) => {
  const state = stateStore.readState();
  res.json({
    ok: true,
    service: 'rocket-pocket-iyc-catalog-connector',
    lastSync: state.lastSync || null
  });
});

app.get('/api/settings/markup-percent', requireApiKey, (_req, res) => {
  res.json({ markupPercent: stateStore.getMarkupPercent() });
});

app.put('/api/settings/markup-percent', requireApiKey, (req, res) => {
  const parsed = Number(req.body && req.body.markupPercent);
  if (!Number.isFinite(parsed) || parsed < 0) {
    res.status(400).json({ error: 'markupPercent must be a number >= 0' });
    return;
  }

  const value = stateStore.setMarkupPercent(parsed);
  res.json({ markupPercent: value });
});

app.post('/api/sync', requireApiKey, async (_req, res) => {
  try {
    const report = await runCatalogSync();
    res.json({ ok: true, report });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/app/settings/markup-percent', (req, res) => {
  const parsed = Number(req.body && req.body.markupPercent);
  if (!Number.isFinite(parsed) || parsed < 0) {
    redirectWithMessage(res, 'error', 'La marginalita deve essere un numero maggiore o uguale a zero.');
    return;
  }

  stateStore.setMarkupPercent(parsed);
  redirectWithMessage(res, 'success', `Marginalita aggiornata a ${parsed}%.`);
});

app.post('/app/sync', async (_req, res) => {
  try {
    const report = await runCatalogSync();
    redirectWithMessage(res, 'success', `Sync completato. Sincronizzati: ${report.synced}, errori: ${report.errors.length}.`);
  } catch (error) {
    redirectWithMessage(res, 'error', `Sync fallito: ${error.message}`);
  }
});

// Global error handler middleware
app.use((err, req, res, next) => {
  console.error('[ERROR] Unhandled error:', err.message);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

let isSyncRunning = false;

async function runScheduledSync() {
  if (isSyncRunning) {
    return;
  }

  isSyncRunning = true;
  try {
    const report = await runCatalogSync();
    console.log('[SYNC] completed', {
      startedAt: report.startedAt,
      synced: report.synced,
      errors: report.errors.length
    });
  } catch (error) {
    console.error('[SYNC] failed', error.message);
  } finally {
    isSyncRunning = false;
  }
}

function startCron() {
  try {
    cron.schedule(config.sync.cron, runScheduledSync, { timezone: 'UTC' });
    console.log(`[CRON] Scheduled with pattern ${config.sync.cron}`);
  } catch (error) {
    console.error('[CRON] Failed to schedule:', error.message);
  }
}

async function bootstrap() {
  const syncOnce = process.argv.includes('--sync-once');

  if (syncOnce) {
    try {
      const report = await runCatalogSync();
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    } catch (error) {
      console.error('[SYNC] One-time sync failed:', error.message);
      process.exit(1);
    }
  }

  // Start HTTP server
  app.listen(config.server.port, () => {
    console.log(`[HTTP] Listening on port ${config.server.port}`);
    
    // Start cron after server is up
    setImmediate(() => {
      startCron();
    });
  }).on('error', (error) => {
    console.error('[HTTP] Server error:', error.message);
  });
}

bootstrap().catch(error => {
  console.error('[BOOT] Fatal error', error.message);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error.message);
  process.exit(1);
});
