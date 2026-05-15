const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const stateStore = require('./store/stateStore');
const { runCatalogSync } = require('./services/catalogSyncService');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/images', express.static(config.paths.imageDir, { maxAge: '7d' }));

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

function serializeForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function renderDashboard({ state, flashMessage = '', flashType = 'info', isSyncRunning = false, syncStartedAt = null, syncRuntime = null }) {
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
    imageFileName: product.imageFileName || '',
    imageUrl: product.imageFileName ? `/images/${encodeURIComponent(product.imageFileName)}` : '',
    lastPrice: product.lastPrice || '-',
    lastBoxPrice: product.lastBoxPrice || '-',
    lastCasePrice: product.lastCasePrice || '-',
    sourceCurrency: product.sourceCurrency || '-',
    updatedAt: product.updatedAt || null
  }));
  const sortedProducts = [...products].sort((left, right) => String(left.title).localeCompare(String(right.title)));
  const dashboardProductsPayload = sortedProducts;

  const productRows = products.length
    ? sortedProducts
        .map((product, index) => `
          <tr class="product-row" tabindex="0" role="button" aria-label="Apri dettagli ${escapeHtml(product.title)}" data-product-index="${index}" data-search="${escapeHtml([product.title, product.handle, product.shopifyProductId, product.lastPrice, product.lastBoxPrice, product.lastCasePrice, product.sourceCurrency].join(' ').toLowerCase())}">
            <td>${product.imageFileName ? `<img class="thumb" src="/images/${encodeURIComponent(product.imageFileName)}" alt="${escapeHtml(product.title)}" loading="lazy" />` : '<span class="empty-thumb">-</span>'}</td>
            <td>${escapeHtml(product.title)}</td>
            <td><code>${escapeHtml(product.handle)}</code></td>
            <td>${escapeHtml(product.shopifyProductId)}</td>
            <td>${escapeHtml(product.lastPrice)}</td>
            <td>${escapeHtml(product.lastBoxPrice)}</td>
            <td>${escapeHtml(product.lastCasePrice)}</td>
            <td>${escapeHtml(product.sourceCurrency)}</td>
            <td>${escapeHtml(formatTimestamp(product.updatedAt))}</td>
          </tr>
        `)
        .join('')
    : `
      <tr>
          <td colspan="9" class="empty">Nessun prodotto sincronizzato ancora.</td>
      </tr>
    `;

  const errorRows = lastSync && Array.isArray(lastSync.errors) && lastSync.errors.length
    ? lastSync.errors
        .map(error => `<li><strong>${escapeHtml(error.productName || 'Unknown product')}:</strong> ${escapeHtml(error.message)}</li>`)
        .join('')
    : '<li>Nessun errore registrato.</li>';

  const runtime = syncRuntime || {
    processed: 0,
    scanned: 0,
    synced: 0,
    skipped: 0,
    errorsCount: 0
  };
  const initialDashboardPayload = {
    sync: {
      running: isSyncRunning,
      startedAt: syncStartedAt,
      processed: Number(runtime.processed || 0),
      scanned: Number(runtime.scanned || 0),
      synced: Number(runtime.synced || 0),
      skipped: Number(runtime.skipped || 0),
      errorsCount: Number(runtime.errorsCount || 0)
    }
  };

  return `<!doctype html>
  <html lang="it">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>IYC Catalog Connector</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
      <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
      <style>
        :root {
          --bg: #050506;
          --bg-grad-1: rgba(185, 28, 28, 0.12);
          --bg-grad-2: rgba(255, 255, 255, 0.03);
          --panel: rgba(14, 14, 18, 0.92);
          --ink: #fafafa;
          --muted: #b0b0ba;
          --line: #2a2a31;
          --accent: #b91c1c;
          --accent-strong: #7f1d1d;
          --warn: #f87171;
          --ok: #34d399;
          --input-bg: #141417;
          --chip-bg: #111114;
          --shadow: 0 18px 48px rgba(31, 36, 31, 0.08);
          color-scheme: dark;
        }

        [data-theme="light"] {
          --bg: #f5f1e8;
          --bg-grad-1: rgba(31, 111, 95, 0.14);
          --bg-grad-2: rgba(143, 61, 46, 0.10);
          --panel: rgba(255, 250, 241, 0.92);
          --ink: #1e241f;
          --muted: #667067;
          --line: #d8cfbe;
          --accent: #1f6f5f;
          --accent-strong: #154d42;
          --warn: #8f3d2e;
          --ok: #1c6b49;
          --input-bg: #fff;
          --chip-bg: #efe6d4;
          color-scheme: light;
        }

        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: 'Manrope', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 12.5px;
          color: var(--ink);
          background:
            radial-gradient(circle at top left, var(--bg-grad-1), transparent 28%),
            radial-gradient(circle at top right, var(--bg-grad-2), transparent 22%),
            linear-gradient(180deg, #09090b 0%, var(--bg) 100%);
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
          background: var(--panel);
          backdrop-filter: blur(8px);
          border: 1px solid var(--line);
          border-radius: 24px;
          box-shadow:
            0 18px 48px rgba(0, 0, 0, 0.32),
            inset 0 1px 0 rgba(255, 255, 255, 0.04);
        }

        .hero-main {
          padding: 28px;
          border-left: 2px solid rgba(185, 28, 28, 0.55);
        }

        .eyebrow {
          margin: 0 0 10px;
          color: #fca5a5;
          font-size: 12px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }

        h1 {
          margin: 0;
          font-family: 'Space Grotesk', 'Manrope', sans-serif;
          font-size: clamp(1.5rem, 2.8vw, 2.45rem);
          line-height: 1;
          letter-spacing: -0.07em;
          font-weight: 700;
        }

        .lead {
          margin: 12px 0 0;
          max-width: 56ch;
          color: #a8a8b4;
          font-size: 13px;
          line-height: 1.55;
        }

        .hero-side {
          padding: 24px;
          display: grid;
          gap: 14px;
          align-content: start;
        }

        .metric-label {
          margin: 0 0 4px;
          color: #9c9ca6;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.16em;
        }

        .metric-value {
          margin: 0;
          font-size: 18px;
          line-height: 1;
          font-weight: 700;
          letter-spacing: -0.04em;
        }

        .flash {
          margin-bottom: 20px;
          padding: 14px 18px;
          border-radius: 16px;
          border: 1px solid var(--line);
          background: rgba(14, 14, 18, 0.82);
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
          font-family: 'Space Grotesk', 'Manrope', sans-serif;
          font-size: 15px;
          font-weight: 700;
          letter-spacing: -0.04em;
        }

        .card p,
        .card li,
        .card label {
          color: #a4a4af;
          line-height: 1.5;
          font-size: 12px;
        }

        form {
          display: grid;
          gap: 14px;
        }

        input[type="number"] {
          width: 100%;
          padding: 11px 13px;
          border-radius: 12px;
          border: 1px solid var(--line);
          background: var(--input-bg);
          font: inherit;
          color: var(--ink);
        }

        button {
          appearance: none;
          border: 0;
          border-radius: 999px;
          padding: 11px 14px;
          background: linear-gradient(135deg, #fca5a5 0%, #b91c1c 42%, #1b1b20 100%);
          color: #fff9f9;
          font: inherit;
          font-weight: 800;
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          font-size: 10px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.18),
            0 12px 28px rgba(127, 29, 29, 0.38);
          transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease;
        }

        button:hover {
          transform: translateY(-1px);
          filter: brightness(1.04);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.24),
            0 14px 30px rgba(127, 29, 29, 0.34);
        }

        button:active {
          transform: translateY(0);
          filter: brightness(0.98);
        }

        button.secondary {
          background: linear-gradient(135deg, #121214 0%, #1f1f24 100%);
          color: #f5f5f7;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.06),
            0 10px 24px rgba(0, 0, 0, 0.26);
        }

        .table-wrap {
          overflow-x: auto;
        }

        .table-toolbar {
          display: grid;
          gap: 10px;
          margin-bottom: 14px;
        }

        .search-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: center;
        }

        .search-input {
          width: 100%;
          padding: 11px 13px;
          border-radius: 12px;
          border: 1px solid var(--line);
          background: var(--input-bg);
          color: var(--ink);
          font: inherit;
          font-size: 12px;
          outline: none;
        }

        .search-input::placeholder {
          color: #7f7f89;
        }

        .search-meta {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          color: #9a9aa5;
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .thumb {
          width: 54px;
          height: 54px;
          object-fit: cover;
          border-radius: 10px;
          border: 1px solid var(--line);
          background: var(--input-bg);
        }

        .product-row {
          cursor: pointer;
          transition: background 160ms ease, transform 160ms ease;
        }

        .product-row:hover {
          background: rgba(185, 28, 28, 0.06);
        }

        .product-row:focus-visible {
          outline: 2px solid rgba(185, 28, 28, 0.5);
          outline-offset: -2px;
        }

        .product-row.is-active {
          background: rgba(185, 28, 28, 0.11);
        }

        .empty-thumb {
          color: var(--muted);
        }

        .drawer-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          opacity: 0;
          pointer-events: none;
          transition: opacity 180ms ease;
          z-index: 40;
        }

        .drawer-backdrop.is-open {
          opacity: 1;
          pointer-events: auto;
        }

        .drawer {
          position: fixed;
          top: 0;
          right: 0;
          width: min(420px, calc(100vw - 28px));
          height: 100vh;
          background: rgba(10, 10, 14, 0.98);
          border-left: 1px solid var(--line);
          box-shadow: -18px 0 50px rgba(0, 0, 0, 0.35);
          transform: translateX(105%);
          transition: transform 220ms ease;
          z-index: 41;
          display: grid;
          grid-template-rows: auto 1fr;
        }

        .drawer.is-open {
          transform: translateX(0);
        }

        .drawer-header {
          padding: 18px 18px 14px;
          border-bottom: 1px solid var(--line);
          display: flex;
          align-items: start;
          justify-content: space-between;
          gap: 12px;
        }

        .drawer-title {
          margin: 0;
          font-family: 'Space Grotesk', 'Manrope', sans-serif;
          font-size: 16px;
          line-height: 1.05;
          letter-spacing: -0.05em;
        }

        .drawer-subtitle {
          margin: 6px 0 0;
          color: #9a9aa5;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }

        .drawer-close {
          width: 34px;
          height: 34px;
          padding: 0;
          border-radius: 999px;
          display: grid;
          place-items: center;
          font-size: 16px;
          line-height: 1;
          background: linear-gradient(135deg, #27272a 0%, #111114 100%);
        }

        .drawer-body {
          padding: 18px;
          overflow: auto;
          display: grid;
          gap: 16px;
        }

        .drawer-hero {
          display: grid;
          gap: 12px;
          align-items: start;
        }

        .drawer-image {
          width: 100%;
          aspect-ratio: 1 / 1;
          object-fit: cover;
          border-radius: 18px;
          border: 1px solid var(--line);
          background: var(--input-bg);
        }

        .drawer-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }

        .drawer-card {
          padding: 12px;
          border: 1px solid var(--line);
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.02);
        }

        .drawer-card label {
          display: block;
          margin: 0 0 5px;
          color: #9a9aa5;
          font-size: 10px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }

        .drawer-card strong {
          font-size: 13px;
          letter-spacing: -0.02em;
        }

        .drawer-note {
          color: #9a9aa5;
          font-size: 12px;
          line-height: 1.5;
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
          color: #9b9ba4;
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        code {
          font-family: 'SFMono-Regular', Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
        }

        .empty {
          color: #9e9ea8;
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

          button {
            width: 100%;
          }

          .drawer {
            width: 100vw;
          }

          .drawer-grid {
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
              <p class="metric-label">Stato sync</p>
              <p class="metric-value">${isSyncRunning ? `In corso (${escapeHtml(formatTimestamp(syncStartedAt))})` : 'Idle'}</p>
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
              <div id="sync-react-root"></div>
              <noscript>
                <form method="post" action="/app/sync">
                  <button type="submit">${isSyncRunning ? 'Sync già in corso' : 'Avvia sync adesso'}</button>
                </form>
              </noscript>
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
            <div class="table-toolbar">
              <div class="search-row">
                <input id="product-search" class="search-input" type="search" placeholder="Cerca prodotto, handle, prezzo, valuta..." aria-label="Cerca prodotti sincronizzati" />
                <button type="button" id="search-clear" class="secondary">Reset</button>
              </div>
              <div class="search-meta">
                <span id="products-visible-count">${products.length} visibili</span>
                <span>Clicca una riga per i dettagli</span>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Immagine</th>
                    <th>Titolo</th>
                    <th>Handle</th>
                    <th>ID Shopify</th>
                    <th>Prezzo (default)</th>
                    <th>Prezzo Box</th>
                    <th>Prezzo Case</th>
                    <th>Valuta</th>
                    <th>Aggiornato</th>
                  </tr>
                </thead>
                <tbody>${productRows}</tbody>
              </table>
            </div>
          </article>
        </section>
        <div class="drawer-backdrop" id="product-drawer-backdrop" aria-hidden="true"></div>
        <aside class="drawer" id="product-drawer" aria-hidden="true" aria-label="Dettagli prodotto">
          <div class="drawer-header">
            <div>
              <p class="drawer-subtitle">Dettagli prodotto</p>
              <h3 class="drawer-title" id="drawer-title">Seleziona un prodotto</h3>
            </div>
            <button type="button" class="drawer-close" id="drawer-close" aria-label="Chiudi dettagli">×</button>
          </div>
          <div class="drawer-body" id="drawer-body">
            <p class="drawer-note">Clicca una riga della tabella per vedere immagine, handle, ID Shopify, prezzi Box/Case e timestamp dell'ultimo aggiornamento.</p>
          </div>
        </aside>
      </main>
      <script id="dashboard-bootstrap" type="application/json">${serializeForScript(initialDashboardPayload)}</script>
      <script id="dashboard-products" type="application/json">${serializeForScript(dashboardProductsPayload)}</script>
      <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
      <script>
        (function () {
          const escapeClientHtml = function (value) {
            return String(value || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
          };

          const productsNode = document.getElementById('dashboard-products');
          const searchInput = document.getElementById('product-search');
          const clearButton = document.getElementById('search-clear');
          const visibleCount = document.getElementById('products-visible-count');
          const rows = Array.from(document.querySelectorAll('.product-row'));
          const drawer = document.getElementById('product-drawer');
          const backdrop = document.getElementById('product-drawer-backdrop');
          const drawerTitle = document.getElementById('drawer-title');
          const drawerBody = document.getElementById('drawer-body');
          const drawerClose = document.getElementById('drawer-close');
          const products = productsNode ? JSON.parse(productsNode.textContent || '[]') : [];

          function openDrawer(product) {
            if (!product || !drawer || !backdrop || !drawerTitle || !drawerBody) {
              return;
            }

            drawerTitle.textContent = product.title || 'Dettagli prodotto';
            const imageMarkup = product.imageUrl
              ? '<img class="drawer-image" src="' + product.imageUrl + '" alt="' + escapeClientHtml(product.title) + '" />'
              : '<div class="drawer-image" style="display:grid;place-items:center;color:#9a9aa5;">Nessuna immagine</div>';

            drawerBody.innerHTML = [
              '<div class="drawer-hero">',
              imageMarkup,
              '<div class="drawer-grid">',
              '<div class="drawer-card"><label>Handle</label><strong>' + escapeClientHtml(product.handle || '-') + '</strong></div>',
              '<div class="drawer-card"><label>ID Shopify</label><strong>' + escapeClientHtml(product.shopifyProductId || '-') + '</strong></div>',
              '<div class="drawer-card"><label>Prezzo default</label><strong>' + escapeClientHtml(product.lastPrice || '-') + '</strong></div>',
              '<div class="drawer-card"><label>Prezzo Box</label><strong>' + escapeClientHtml(product.lastBoxPrice || '-') + '</strong></div>',
              '<div class="drawer-card"><label>Prezzo Case</label><strong>' + escapeClientHtml(product.lastCasePrice || '-') + '</strong></div>',
              '<div class="drawer-card"><label>Valuta</label><strong>' + escapeClientHtml(product.sourceCurrency || '-') + '</strong></div>',
              '</div>',
              '<div class="drawer-card">',
              '<label>Ultimo aggiornamento</label>',
              '<strong>' + escapeClientHtml(product.updatedAt || '-') + '</strong>',
              '</div>',
              '</div>'
            ].join('');

            drawer.classList.add('is-open');
            backdrop.classList.add('is-open');
            drawer.setAttribute('aria-hidden', 'false');
            backdrop.setAttribute('aria-hidden', 'false');
          }

          function closeDrawer() {
            if (!drawer || !backdrop) {
              return;
            }

            drawer.classList.remove('is-open');
            backdrop.classList.remove('is-open');
            drawer.setAttribute('aria-hidden', 'true');
            backdrop.setAttribute('aria-hidden', 'true');
          }

          function applySearch(query) {
            const normalized = String(query || '').trim().toLowerCase();
            let visible = 0;

            rows.forEach((row) => {
              const text = row.getAttribute('data-search') || '';
              const matches = !normalized || text.includes(normalized);
              row.style.display = matches ? '' : 'none';
              if (matches) {
                visible += 1;
              }
            });

            if (visibleCount) {
              visibleCount.textContent = visible + ' visibili';
            }
          }

          rows.forEach((row) => {
            row.addEventListener('click', () => {
              rows.forEach((candidate) => candidate.classList.remove('is-active'));
              row.classList.add('is-active');
              const index = Number(row.getAttribute('data-product-index'));
              if (!Number.isFinite(index)) {
                return;
              }
              openDrawer(products[index]);
            });

            row.addEventListener('keydown', (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                row.click();
              }
            });
          });

          if (searchInput) {
            searchInput.addEventListener('input', (event) => applySearch(event.target.value));
          }

          if (clearButton && searchInput) {
            clearButton.addEventListener('click', () => {
              searchInput.value = '';
              applySearch('');
              searchInput.focus();
            });
          }

          if (drawerClose) {
            drawerClose.addEventListener('click', closeDrawer);
          }

          if (backdrop) {
            backdrop.addEventListener('click', closeDrawer);
          }

          document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
              closeDrawer();
            }
          });

          applySearch('');
        })();
      </script>
      <script>
        (function () {
          const rootNode = document.getElementById('sync-react-root');
          const bootstrapNode = document.getElementById('dashboard-bootstrap');
          if (!rootNode || !bootstrapNode || !window.React || !window.ReactDOM) {
            return;
          }

          const bootstrap = JSON.parse(bootstrapNode.textContent || '{}');
          const e = window.React.createElement;

          function SyncWidget() {
            const initialSync = bootstrap.sync || {};
            const [sync, setSync] = window.React.useState(initialSync);
            const [message, setMessage] = window.React.useState('');
            const [wasRunning, setWasRunning] = window.React.useState(Boolean(initialSync.running));

            const refreshStatus = window.React.useCallback(async function () {
              try {
                const response = await fetch('/app/state', { cache: 'no-store' });
                if (!response.ok) {
                  return;
                }

                const payload = await response.json();
                const nextSync = payload && payload.sync ? payload.sync : null;
                if (!nextSync) {
                  return;
                }

                setSync(nextSync);

                if (nextSync.running) {
                  setWasRunning(true);
                }

                if (!nextSync.running && wasRunning) {
                  window.location.reload();
                }
              } catch (_error) {
                // Ignore transient polling errors.
              }
            }, [wasRunning]);

            window.React.useEffect(function () {
              const timer = setInterval(refreshStatus, 2000);
              return function () { clearInterval(timer); };
            }, [refreshStatus]);

            const progressPercent = sync.scanned > 0
              ? Math.min(100, Math.round((sync.processed / sync.scanned) * 100))
              : 0;

            const onStart = async function () {
              setMessage('Avvio sync...');
              try {
                const response = await fetch('/app/sync/start', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' }
                });
                const payload = await response.json();
                if (!response.ok) {
                  setMessage(payload.error || 'Impossibile avviare il sync.');
                  return;
                }

                setMessage(payload.message || 'Sync avviato in background.');
                refreshStatus();
              } catch (_error) {
                setMessage('Errore di rete durante avvio sync.');
              }
            };

            return e('div', { style: { display: 'grid', gap: '12px' } }, [
              e('button', {
                key: 'button',
                type: 'button',
                onClick: onStart,
                disabled: Boolean(sync.running),
                style: sync.running ? { opacity: 0.7, cursor: 'not-allowed' } : undefined
              }, sync.running ? 'Sync in corso...' : 'Avvia sync adesso'),
              sync.running ? e('div', { key: 'progress-wrap', style: { display: 'grid', gap: '8px' } }, [
                e('div', {
                  key: 'bar-bg',
                  style: {
                    width: '100%',
                    height: '10px',
                    background: '#efe6d4',
                    borderRadius: '999px',
                    overflow: 'hidden'
                  }
                }, e('div', {
                  style: {
                    width: progressPercent + '%',
                    height: '100%',
                    background: '#1f6f5f',
                    transition: 'width 200ms ease'
                  }
                })),
                e('p', { key: 'progress-text', style: { margin: 0 } },
                  'Progresso: ' + progressPercent + '% (' + (sync.processed || 0) + '/' + (sync.scanned || 0) + ')'
                ),
                e('p', { key: 'progress-sub', style: { margin: 0 } },
                  'Sincronizzati: ' + (sync.synced || 0) + ' | Saltati: ' + (sync.skipped || 0) + ' | Errori: ' + (sync.errorsCount || 0)
                )
              ]) : null,
              message ? e('p', { key: 'message', style: { margin: 0 } }, message) : null
            ]);
          }

          window.ReactDOM.createRoot(rootNode).render(e(SyncWidget));
        })();
      </script>
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
    res.type('html').send(renderDashboard({
      state,
      flashMessage,
      flashType,
      isSyncRunning,
      syncStartedAt: syncRuntime.startedAt,
      syncRuntime
    }));
  } catch (error) {
    console.error('[HTTP] GET / error:', error.message);
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
});

app.get('/app/state', (_req, res) => {
  const state = stateStore.readState();
  res.json({
    state,
    sync: {
      running: isSyncRunning,
      startedAt: syncRuntime.startedAt,
      processed: Number(syncRuntime.processed || 0),
      scanned: Number(syncRuntime.scanned || 0),
      synced: Number(syncRuntime.synced || 0),
      skipped: Number(syncRuntime.skipped || 0),
      errorsCount: Number(syncRuntime.errorsCount || 0)
    }
  });
});

app.get('/auth/start', (req, res) => {
  const configuredShop = String(config.shopify.storeDomain || '').trim().toLowerCase();
  const queryShop = String(req.query.shop || '').trim().toLowerCase();

  if (queryShop && configuredShop && queryShop !== configuredShop) {
    redirectWithMessage(res, 'error', `Apri l'app nello store configurato (${configuredShop}) e riprova.`);
    return;
  }

  const shop = configuredShop;
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
  const shop = String(req.query.shop || '').trim().toLowerCase();
  const code = String(req.query.code || '').trim();
  const nonce = String(req.query.state || '').trim();
  const configuredShop = String(config.shopify.storeDomain || '').trim().toLowerCase();
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
  const hasValidStateFromStore = Boolean(
    pendingState && (
      pendingState.shopDomain === shop ||
      pendingState.shopDomain === configuredShop
    )
  );
  const hasValidStateFromCookie = Boolean(nonceFromCookie && nonceFromCookie === nonce);
  if (!hasValidStateFromStore && !hasValidStateFromCookie) {
    redirectWithMessage(res, 'error', 'Stato OAuth Shopify non valido o scaduto.');
    return;
  }

  // Clear oauth state cookie after successful validation.
  res.setHeader('Set-Cookie', 'oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');

  // Shopify can return callback shop values that differ from the configured primary domain
  // (for example, additional domains linked to the same store). In personal single-store mode
  // we still persist the token under the configured shop domain.
  if (shop !== configuredShop) {
    console.warn(`[AUTH] Callback shop differs from configured shop. callback=${shop} configured=${configuredShop}`);
  }

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

    stateStore.setShopifyInstallation(configuredShop, {
      adminAccessToken: payload.access_token,
      scope: payload.scope || config.shopify.accessScopes,
      installedAt: new Date().toISOString(),
      callbackShopDomain: shop
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

app.post('/api/sync', requireApiKey, (_req, res) => {
  const started = startSync('api');
  if (!started) {
    res.status(409).json({ ok: false, error: 'Sync già in corso.' });
    return;
  }

  res.status(202).json({ ok: true, message: 'Sync avviato in background.' });
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

app.post('/app/sync', (_req, res) => {
  const started = startSync('dashboard');
  if (!started) {
    redirectWithMessage(res, 'info', 'Sync già in corso. Attendi il completamento e aggiorna la pagina.');
    return;
  }

  redirectWithMessage(res, 'success', 'Sync avviato in background. Puoi continuare a usare la dashboard.');
});

app.post('/app/sync/start', (_req, res) => {
  const started = startSync('dashboard-react');
  if (!started) {
    res.status(409).json({ ok: false, error: 'Sync già in corso.' });
    return;
  }

  res.status(202).json({ ok: true, message: 'Sync avviato in background.' });
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
const syncRuntime = {
  startedAt: null,
  trigger: null,
  processed: 0,
  scanned: 0,
  synced: 0,
  skipped: 0,
  errorsCount: 0
};

function startSync(trigger) {
  if (isSyncRunning) {
    return false;
  }

  isSyncRunning = true;
  syncRuntime.startedAt = new Date().toISOString();
  syncRuntime.trigger = trigger;
  syncRuntime.processed = 0;
  syncRuntime.scanned = 0;
  syncRuntime.synced = 0;
  syncRuntime.skipped = 0;
  syncRuntime.errorsCount = 0;

  setImmediate(async () => {
    try {
      const report = await runCatalogSync({
        onProgress: progress => {
          syncRuntime.processed = Number(progress.processed || 0);
          syncRuntime.scanned = Number(progress.scanned || 0);
          syncRuntime.synced = Number(progress.synced || 0);
          syncRuntime.skipped = Number(progress.skipped || 0);
          syncRuntime.errorsCount = Number(progress.errorsCount || 0);
        }
      });
      console.log('[SYNC] completed', {
        trigger,
        startedAt: report.startedAt,
        synced: report.synced,
        errors: report.errors.length
      });
    } catch (error) {
      console.error('[SYNC] failed', { trigger, error: error.message });
    } finally {
      isSyncRunning = false;
      syncRuntime.startedAt = null;
      syncRuntime.trigger = null;
      syncRuntime.processed = 0;
      syncRuntime.scanned = 0;
      syncRuntime.synced = 0;
      syncRuntime.skipped = 0;
      syncRuntime.errorsCount = 0;
    }
  });

  return true;
}

async function runScheduledSync() {
  const started = startSync('cron');
  if (!started) {
    console.log('[SYNC] skipped (already running)');
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
