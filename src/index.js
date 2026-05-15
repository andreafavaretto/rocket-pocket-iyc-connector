const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const stateStore = require('./store/stateStore');
const { runCatalogSync } = require('./services/catalogSyncService');
const shopify = require('./services/shopifyService');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const configuredShop = String(config.shopify.storeDomain || '').trim().toLowerCase();
  const queryShop = String(req.query && req.query.shop ? req.query.shop : '').trim().toLowerCase();
  const shops = [configuredShop, queryShop].filter(shop => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop));

  const frameAncestors = new Set([
    "'self'",
    'https://admin.shopify.com',
    ...shops.map(shop => `https://${shop}`)
  ]);

  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${Array.from(frameAncestors).join(' ')};`);
  next();
});

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

function normalizeVariantKey(value) {
  return String(value || '').trim().toLowerCase();
}

function hasCatalogTag(tags) {
  const expected = String(config.shopify.catalogTag || '').trim().toLowerCase();
  if (!expected) {
    return true;
  }

  return String(tags || '')
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean)
    .includes(expected);
}

function productStateFromShopify(product, markupPercent) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const caseVariant = variants.find(variant => normalizeVariantKey(variant.option1 || variant.title).startsWith('case'));
  const boxVariant = variants.find(variant => normalizeVariantKey(variant.option1 || variant.title) === 'box');
  const selected = caseVariant || variants[0] || null;
  const imageUrl = Array.isArray(product.images) && product.images.length
    ? String(product.images[0].src || '').trim()
    : '';

  return {
    title: product.title || product.handle || String(product.id || ''),
    shopifyProductId: product.id || '-',
    imageFileName: null,
    shopifyImageUrl: imageUrl,
    lastPrice: selected && selected.price ? String(selected.price) : '-',
    lastCasePrice: caseVariant && caseVariant.price ? String(caseVariant.price) : null,
    lastBoxPrice: boxVariant && boxVariant.price ? String(boxVariant.price) : null,
    sourceCurrency: '-',
    pricingByCurrency: [],
    markupPercentApplied: Number(markupPercent || 0),
    updatedAt: product.updated_at || new Date().toISOString()
  };
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
    imageUrl: product.imageFileName
      ? `/images/${encodeURIComponent(product.imageFileName)}`
      : String(product.shopifyImageUrl || '').trim(),
    lastPrice: product.lastPrice || '-',
    lastBoxPrice: product.lastBoxPrice || '-',
    lastCasePrice: product.lastCasePrice || '-',
    sourceCurrency: product.sourceCurrency || '-',
    pricingByCurrency: Array.isArray(product.pricingByCurrency) ? product.pricingByCurrency : [],
    markupPercentApplied: Number.isFinite(Number(product.markupPercentApplied))
      ? Number(product.markupPercentApplied)
      : Number(markupPercent || 0),
    updatedAt: product.updatedAt || null
  }));
  const sortedProducts = [...products].sort((left, right) => String(left.title).localeCompare(String(right.title)));
  const dashboardProductsPayload = sortedProducts;

  const productRows = products.length
    ? sortedProducts
        .map((product, index) => `
          <tr class="product-row" tabindex="0" role="button" aria-label="Apri dettagli ${escapeHtml(product.title)}" data-product-index="${index}" data-search="${escapeHtml([product.title, product.handle, product.shopifyProductId, product.lastPrice, product.lastBoxPrice, product.lastCasePrice, product.sourceCurrency].join(' ').toLowerCase())}">
            <td>${product.imageUrl ? `<img class="thumb" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}" loading="lazy" />` : '<span class="empty-thumb">-</span>'}</td>
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
    changed: 0,
    unchanged: 0,
    currentProduct: null,
    recentProducts: [],
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
      changed: Number(runtime.changed || 0),
      unchanged: Number(runtime.unchanged || 0),
      currentProduct: runtime.currentProduct || null,
      recentProducts: Array.isArray(runtime.recentProducts) ? runtime.recentProducts : [],
      skipped: Number(runtime.skipped || 0),
      errorsCount: Number(runtime.errorsCount || 0)
    },
    lastSync,
    markupPercent
  };

  const serverProgressPercent = runtime.scanned > 0
    ? Math.min(100, Math.round((runtime.processed / runtime.scanned) * 100))
    : 0;
  const syncLiveFallbackMarkup = isSyncRunning
    ? `
      <div class="sync-live-panel" id="sync-live-fallback">
        <p class="sync-live-title">Sto sincronizzando i prodotti con gli ultimi prezzi disponibili</p>
        <div style="width:100%;height:10px;background:#e4e5e7;border-radius:999px;overflow:hidden;">
          <div style="width:${serverProgressPercent}%;height:100%;background:#008060;transition:width 200ms ease;"></div>
        </div>
        <div class="sync-live-meta">
          <span>Progresso: ${serverProgressPercent}%</span>
          <span>Processati: ${Number(runtime.processed || 0)}/${Number(runtime.scanned || 0)}</span>
          <span>Sincronizzati: ${Number(runtime.synced || 0)}</span>
          <span>Cambiati: ${Number(runtime.changed || 0)}</span>
          <span>Invariati: ${Number(runtime.unchanged || 0)}</span>
          <span>Errori: ${Number(runtime.errorsCount || 0)}</span>
        </div>
      </div>
    `
    : '<div id="sync-live-fallback"></div>';

  return `<!doctype html>
  <html lang="it">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>IYC Catalog Connector</title>
      <style>
        :root {
          --bg: #f1f2f4;
          --panel: #ffffff;
          --ink: #202223;
          --muted: #6d7175;
          --line: #d9dcde;
          --accent: #008060;
          --accent-strong: #006e52;
          --warn: #d72c0d;
          --ok: #108043;
          --input-bg: #ffffff;
          --chip-bg: #f6f6f7;
          --shadow: 0 1px 0 rgba(22, 29, 37, 0.05), 0 2px 6px rgba(22, 29, 37, 0.06);
          color-scheme: light;
        }

        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          font-size: 12.5px;
          color: var(--ink);
          background: var(--bg);
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
          border: 1px solid var(--line);
          border-radius: 12px;
          box-shadow: var(--shadow);
        }

        .hero-main {
          padding: 28px;
        }

        .eyebrow {
          margin: 0 0 10px;
          color: var(--accent);
          font-size: 12px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        h1 {
          margin: 0;
          font-size: clamp(1.35rem, 2.2vw, 2rem);
          line-height: 1.2;
          letter-spacing: -0.02em;
          font-weight: 650;
        }

        .lead {
          margin: 12px 0 0;
          max-width: 56ch;
          color: var(--muted);
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
          color: var(--muted);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
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
          border-radius: 10px;
          border: 1px solid var(--line);
          background: #ffffff;
        }

        .flash.info { color: var(--accent-strong); }
        .flash.error { color: var(--warn); border-color: rgba(143, 61, 46, 0.28); }
        .flash.success { color: var(--ok); border-color: rgba(28, 107, 73, 0.28); }

        .grid {
          display: grid;
          grid-template-columns: 380px minmax(0, 1fr);
          gap: 20px;
          align-items: start;
        }

        .stack {
          display: grid;
          gap: 20px;
          align-content: start;
          grid-auto-rows: min-content;
        }

        .sync-live-full-row {
          margin: 0 0 20px;
        }

        .card {
          padding: 24px;
        }

        .ops-widget {
          display: flex;
          flex-direction: column;
          gap: 18px;
          align-items: stretch;
          justify-content: flex-start;
        }

        .ops-section {
          display: flex;
          flex-direction: column;
          gap: 10px;
          align-items: stretch;
          justify-content: flex-start;
        }

        .ops-section h2 {
          margin: 0;
        }

        .ops-section p {
          margin: 0;
        }

        .ops-section-auth {
          gap: 4px;
        }

        .ops-section-auth form {
          margin-top: 8px;
        }

        .ops-section + .ops-section {
          border-top: 1px solid var(--line);
          padding-top: 18px;
        }

        .card h2 {
          margin: 0 0 14px;
          font-size: 15px;
          font-weight: 700;
          letter-spacing: -0.01em;
        }

        .card p,
        .card li,
        .card label {
          color: var(--muted);
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
          border: 1px solid #00664f;
          border-radius: 8px;
          padding: 11px 14px;
          background: #008060;
          color: #ffffff;
          font: inherit;
          font-weight: 600;
          cursor: pointer;
          font-size: 12px;
          box-shadow: none;
          transition: none;
        }

        button:disabled,
        button[aria-disabled="true"] {
          background: #e4e5e7;
          border-color: #c9cccf;
          color: #8c9196;
          cursor: not-allowed;
        }

        button:hover {
          background: #006e52;
        }

        button:active {
          background: #00533e;
        }

        button.secondary {
          background: #ffffff;
          color: #202223;
          border: 1px solid #babfc3;
        }

        .btn-with-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .btn-icon {
          font-size: 12px;
          line-height: 1;
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
          color: #8c9196;
        }

        .search-meta {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          color: var(--muted);
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
          background: #f6f6f7;
        }

        .product-row:focus-visible {
          outline: 2px solid rgba(0, 128, 96, 0.45);
          outline-offset: -2px;
        }

        .product-row.is-active {
          background: #edf7f4;
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
          background: #ffffff;
          border-left: 1px solid var(--line);
          box-shadow: -8px 0 28px rgba(22, 29, 37, 0.12);
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
          font-size: 16px;
          line-height: 1.05;
          letter-spacing: -0.01em;
        }

        .drawer-subtitle {
          margin: 6px 0 0;
          color: var(--muted);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .drawer-close {
          width: 34px;
          height: 34px;
          padding: 0;
          border-radius: 8px;
          display: grid;
          place-items: center;
          font-size: 16px;
          line-height: 1;
          background: #ffffff;
          border: 1px solid var(--line);
          color: var(--ink);
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
          border-radius: 10px;
          background: #ffffff;
        }

        .drawer-card label {
          display: block;
          margin: 0 0 5px;
          color: var(--muted);
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .drawer-card strong {
          font-size: 13px;
          letter-spacing: -0.02em;
        }

        .drawer-note {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.5;
        }

        .drawer-pricing-title {
          margin: 2px 0 0;
          color: var(--ink);
          font-size: 12px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .drawer-pricing-wrap {
          border: 1px solid var(--line);
          border-radius: 10px;
          overflow: hidden;
          background: #ffffff;
        }

        .drawer-pricing-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11px;
        }

        .drawer-pricing-table th,
        .drawer-pricing-table td {
          border-bottom: 1px solid var(--line);
          padding: 9px 10px;
          white-space: normal;
        }

        .drawer-pricing-table th {
          font-size: 10px;
          color: var(--muted);
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }

        .drawer-pricing-table tr:last-child td {
          border-bottom: 0;
        }

        .drawer-pricing-empty {
          color: var(--muted);
          text-align: center;
        }

        .sync-live-panel {
          border: 1px solid var(--line);
          background: #ffffff;
          border-radius: 10px;
          padding: 12px;
          display: grid;
          gap: 10px;
        }

        .sync-live-title {
          margin: 0;
          color: var(--ink);
          font-size: 12px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }

        .sync-current-row {
          display: grid;
          grid-template-columns: 44px minmax(0, 1fr);
          gap: 10px;
          align-items: center;
        }

        .sync-current-thumb {
          width: 44px;
          height: 44px;
          border-radius: 10px;
          object-fit: cover;
          border: 1px solid var(--line);
          background: var(--input-bg);
        }

        .sync-current-text {
          margin: 0;
          color: var(--ink);
          font-size: 12px;
          line-height: 1.4;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .sync-live-meta {
          color: var(--muted);
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .sync-live-list {
          margin: 0;
          padding-left: 18px;
          color: var(--ink);
          font-size: 11px;
          display: grid;
          gap: 4px;
          max-height: 140px;
          overflow: auto;
        }

        .sync-live-actions {
          display: flex;
          justify-content: flex-end;
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

        .sync-live-title-main {
          margin: 0 0 14px;
          font-size: 15px;
          font-weight: 700;
          letter-spacing: -0.01em;
          color: var(--ink);
        }

        @keyframes glow-rotate {
          0% {
            box-shadow: 0 0 0 1px #1f6f5f, 0 0 12px 0 rgba(31, 111, 95, 0.3);
          }
          25% {
            box-shadow: 0 0 0 1px #1f6f5f, 4px 0 12px 0 rgba(31, 111, 95, 0.4);
          }
          50% {
            box-shadow: 0 0 0 1px #1f6f5f, 0 4px 12px 0 rgba(31, 111, 95, 0.3);
          }
          75% {
            box-shadow: 0 0 0 1px #1f6f5f, -4px 0 12px 0 rgba(31, 111, 95, 0.4);
          }
          100% {
            box-shadow: 0 0 0 1px #1f6f5f, 0 0 12px 0 rgba(31, 111, 95, 0.3);
          }
        }

        .sync-live-panel.is-running {
          animation: glow-rotate 2.5s ease-in-out infinite;
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

        <section class="sync-live-full-row">
          ${syncLiveFallbackMarkup}
          <div id="sync-react-root"></div>
        </section>

        <section class="grid">
          <div class="stack">
            <article class="panel card ops-widget">
              <section class="ops-section ops-section-auth">
                <h2>Autorizzazione Shopify</h2>
                <p>Stato attuale: <strong>${hasStoredInstallation ? 'autorizzato via OAuth' : 'non autorizzato via OAuth'}</strong>.</p>
                <p>${installation ? `Token OAuth aggiornato il ${escapeHtml(formatTimestamp(installation.updatedAt))}.` : 'Serve un passaggio OAuth per ottenere il token offline dello store.'}</p>
                <p>${hasStaticToken ? 'E presente anche un token statico nel file .env, ma il sync usera il token OAuth salvato appena disponibile.' : 'Nessun token statico configurato nel file .env.'}</p>
                <form method="get" action="/auth/start" target="_top" id="shopify-connect-form">
                  <button type="submit" class="btn-with-icon ${hasStoredInstallation ? 'secondary' : ''}"><span class="btn-icon" aria-hidden="true">🔗</span>${hasStoredInstallation ? 'Riconnetti Shopify' : 'Connetti Shopify'}</button>
                </form>
              </section>

              <section class="ops-section">
                <h2>Marginalità</h2>
                <form method="post" action="/app/settings/markup-percent">
                  <label for="markupPercent">Percentuale da applicare ai prezzi importati</label>
                  <input id="markupPercent" name="markupPercent" type="number" min="0" step="0.01" value="${escapeHtml(markupPercent)}" />
                  <button type="submit" class="btn-with-icon"><span class="btn-icon" aria-hidden="true">💾</span>Salva marginalità</button>
                </form>
              </section>

              <section class="ops-section">
                <h2>Sync manuale</h2>
                <p>Usa questo comando per forzare subito il caricamento del catalogo dal Google Sheet e aggiornare i prodotti su Shopify.</p>
                <div id="sync-fallback-root">
                  <form method="post" action="/app/sync">
                    <button type="submit" class="btn-with-icon" ${isSyncRunning ? 'disabled aria-disabled="true"' : ''}><span class="btn-icon" aria-hidden="true">⟳</span>${isSyncRunning ? 'Sync già in corso' : 'Avvia sync adesso'}</button>
                  </form>
                </div>
                <noscript>
                  <form method="post" action="/app/sync">
                    <button type="submit" class="btn-with-icon" ${isSyncRunning ? 'disabled aria-disabled="true"' : ''}><span class="btn-icon" aria-hidden="true">⟳</span>${isSyncRunning ? 'Sync già in corso' : 'Avvia sync adesso'}</button>
                  </form>
                </noscript>
              </section>
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
      <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
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
          const connectForm = document.getElementById('shopify-connect-form');
          const products = productsNode ? JSON.parse(productsNode.textContent || '[]') : [];

          if (connectForm) {
            connectForm.addEventListener('submit', function (event) {
              const targetUrl = connectForm.getAttribute('action') || '/auth/start';
              if (window.top && window.top !== window) {
                event.preventDefault();
                try {
                  window.top.location.href = targetUrl;
                } catch (_error) {
                  window.location.href = targetUrl;
                }
              }
            });
          }

          function openDrawer(product) {
            if (!product || !drawer || !backdrop || !drawerTitle || !drawerBody) {
              return;
            }

            drawerTitle.textContent = product.title || 'Dettagli prodotto';
            const imageMarkup = product.imageUrl
              ? '<img class="drawer-image" src="' + product.imageUrl + '" alt="' + escapeClientHtml(product.title) + '" />'
              : '<div class="drawer-image" style="display:grid;place-items:center;color:#9a9aa5;">Nessuna immagine</div>';

            const markupValue = Number.isFinite(Number(product.markupPercentApplied))
              ? Number(product.markupPercentApplied)
              : 0;

            const pricingRows = Array.isArray(product.pricingByCurrency) && product.pricingByCurrency.length
              ? product.pricingByCurrency.map(function (entry) {
                  return [
                    '<tr>',
                    '<td>' + escapeClientHtml(entry.currency || '-') + '</td>',
                    '<td>' + escapeClientHtml(entry.unitOriginal || '-') + '</td>',
                    '<td>' + escapeClientHtml(entry.unitMarkedUp || '-') + '</td>',
                    '<td>' + escapeClientHtml(entry.caseOriginal || '-') + '</td>',
                    '<td>' + escapeClientHtml(entry.caseMarkedUp || '-') + '</td>',
                    '</tr>'
                  ].join('');
                }).join('')
              : '<tr><td colspan="5" class="drawer-pricing-empty">Dettaglio valute disponibile dopo il prossimo sync.</td></tr>';

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
              '<div class="drawer-card"><label>Rincaro applicato</label><strong>' + escapeClientHtml(markupValue + '%') + '</strong></div>',
              '</div>',
              '<p class="drawer-pricing-title">Prezzi per valuta (originale vs con rincaro ' + escapeClientHtml(markupValue + '%') + ')</p>',
              '<div class="drawer-pricing-wrap">',
              '<table class="drawer-pricing-table">',
              '<thead><tr><th>Valuta</th><th>Box orig.</th><th>Box con rincaro</th><th>Case orig.</th><th>Case con rincaro</th></tr></thead>',
              '<tbody>',
              pricingRows,
              '</tbody>',
              '</table>',
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
          const liveFallbackNode = document.getElementById('sync-live-fallback');
          const fallbackNode = document.getElementById('sync-fallback-root');
          const bootstrapNode = document.getElementById('dashboard-bootstrap');
          if (!bootstrapNode) {
            return;
          }

          const bootstrap = JSON.parse(bootstrapNode.textContent || '{}');

          function escapeHtml(value) {
            return String(value || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
          }

          function renderFallbackSync(nextSync) {
            if (!liveFallbackNode) {
              return;
            }

            const sync = nextSync || {};
            if (!sync.running) {
              liveFallbackNode.className = '';
              liveFallbackNode.innerHTML = '';
              return;
            }

            const scanned = Number(sync.scanned || 0);
            const processed = Number(sync.processed || 0);
            const progressPercent = scanned > 0
              ? Math.min(100, Math.round((processed / scanned) * 100))
              : 0;
            const currentProduct = sync.currentProduct || null;
            const recentProducts = Array.isArray(sync.recentProducts) ? sync.recentProducts : [];
            const previousProduct = recentProducts.length ? recentProducts[0] : null;

            const currentBlock = currentProduct
              ? [
                  '<div class="sync-current-row">',
                  currentProduct.imageUrl
                    ? '<img class="sync-current-thumb" src="' + escapeHtml(currentProduct.imageUrl) + '" alt="' + escapeHtml(currentProduct.title || 'Prodotto in sync') + '" />'
                    : '<div class="sync-current-thumb" style="display:grid;place-items:center;color:#8f8f99;font-size:10px;">N/A</div>',
                  '<div style="flex:1;">',
                  '<p class="sync-current-text">Sincronizzo ' + escapeHtml(currentProduct.title || 'prodotto') + '</p>',
                  '<p style="margin:4px 0 0;font-size:11px;color:#9a9aa5;">' + escapeHtml((currentProduct.index || 0) + '/' + (currentProduct.total || scanned || 0)) + '</p>',
                  '</div>',
                  '</div>'
                ].join('')
              : '';

            const previousBlock = previousProduct
              ? [
                  '<div style="border-top:1px solid #d0cec4;margin:8px 0;"></div>',
                  '<div class="sync-current-row" style="opacity:0.85;">',
                  previousProduct.imageUrl
                    ? '<img class="sync-current-thumb" src="' + escapeHtml(previousProduct.imageUrl) + '" alt="' + escapeHtml(previousProduct.title || 'Prodotto precedente') + '" />'
                    : '<div class="sync-current-thumb" style="display:grid;place-items:center;color:#8f8f99;font-size:10px;">N/A</div>',
                  '<div style="flex:1;">',
                  '<p class="sync-current-text">✓ ' + escapeHtml(previousProduct.title || 'prodotto') + '</p>',
                  '<p style="margin:4px 0 0;font-size:11px;color:#9a9aa5;">' + escapeHtml(previousProduct.handle ? ('Handle: ' + previousProduct.handle) : '-') + '</p>',
                  '</div>',
                  '</div>'
                ].join('')
              : '';

            liveFallbackNode.className = 'sync-live-panel is-running';
            liveFallbackNode.innerHTML = [
              '<h2 class="sync-live-title-main">Sto sincronizzando i prodotti con gli ultimi prezzi disponibili</h2>',
              currentBlock,
              previousBlock,
              '<div style="width:100%;height:10px;background:#e4e5e7;border-radius:999px;overflow:hidden;margin-top:' + (previousProduct ? '8px' : '0') + ';">',
              '<div style="width:' + progressPercent + '%;height:100%;background:#008060;transition:width 200ms ease;"></div>',
              '</div>',
              '<div class="sync-live-meta">',
              '<span>Progresso: ' + progressPercent + '%</span>',
              '<span>Processati: ' + processed + '/' + scanned + '</span>',
              '<span>Sincronizzati: ' + Number(sync.synced || 0) + '</span>',
              '<span>Cambiati: ' + Number(sync.changed || 0) + '</span>',
              '<span>Invariati: ' + Number(sync.unchanged || 0) + '</span>',
              '<span>Errori: ' + Number(sync.errorsCount || 0) + '</span>',
              '</div>'
            ].join('');
          }

          function startFallbackPolling() {
            const poll = async function () {
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
                renderFallbackSync(nextSync);
              } catch (_error) {
                // Ignore transient polling errors in fallback mode.
              }
            };

            poll();
            setInterval(poll, 2000);
          }

          if (!rootNode || !window.React || !window.ReactDOM) {
            startFallbackPolling();
            return;
          }

          const e = window.React.createElement;

          function SyncWidget() {
            const initialSync = bootstrap.sync || {};
            const initialLastSync = bootstrap.lastSync || null;
            const [sync, setSync] = window.React.useState(initialSync);
            const [lastSyncReport, setLastSyncReport] = window.React.useState(initialLastSync);
            const [message, setMessage] = window.React.useState('');
            const [showLastReport, setShowLastReport] = window.React.useState(Boolean(initialLastSync));
            const completedSyncRef = window.React.useRef(initialLastSync && initialLastSync.finishedAt ? initialLastSync.finishedAt : '');

            window.React.useEffect(function () {
              const poll = async () => {
                try {
                  const response = await fetch('/app/state', { cache: 'no-store' });
                  if (!response.ok) return;

                  const payload = await response.json();
                  const nextSync = payload && payload.sync ? payload.sync : null;
                  if (!nextSync) return;

                  if (nextSync.running) {
                    console.log('[POLL] sync running', {
                      processed: nextSync.processed,
                      scanned: nextSync.scanned,
                      recentProducts: Array.isArray(nextSync.recentProducts) ? nextSync.recentProducts.length : 0,
                      currentProduct: nextSync.currentProduct ? nextSync.currentProduct.title : null
                    });
                  }

                  setSync(nextSync);

                  const nextLastSync = payload && payload.state ? payload.state.lastSync : null;
                  if (!nextSync.running && nextLastSync && nextLastSync.finishedAt) {
                    if (completedSyncRef.current !== nextLastSync.finishedAt) {
                      completedSyncRef.current = nextLastSync.finishedAt;
                      setLastSyncReport(nextLastSync);
                      setShowLastReport(true);
                      setMessage('Sync completato. Dati aggiornati.');
                    }
                  }
                } catch (_error) {
                  console.error('[POLL] error', _error.message);
                }
              };

              poll();
              const timer = setInterval(poll, 2000);
              return function () { clearInterval(timer); };
            }, []);

            const progressPercent = sync.scanned > 0
              ? Math.min(100, Math.round((sync.processed / sync.scanned) * 100))
              : 0;

            const currentProduct = sync && sync.currentProduct ? sync.currentProduct : null;
            const recentProducts = Array.isArray(sync.recentProducts) ? sync.recentProducts : [];
            const changedProducts = lastSyncReport && Array.isArray(lastSyncReport.changedProducts)
              ? lastSyncReport.changedProducts
              : [];

            const dismissLastReport = function () {
              setShowLastReport(false);
            };

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
              } catch (_error) {
                setMessage('Errore di rete durante avvio sync.');
              }
            };

            const previousProduct = recentProducts && recentProducts.length > 0 ? recentProducts[0] : null;

            const livePanel = sync.running
              ? e('div', { key: 'live-panel', className: 'sync-live-panel is-running' }, [
                  e('h2', { key: 'live-title', className: 'sync-live-title-main' },
                    'Sto sincronizzando i prodotti con gli ultimi prezzi disponibili'
                  ),
                  currentProduct
                    ? e('div', { key: 'current-row', className: 'sync-current-row' }, [
                        currentProduct.imageUrl
                          ? e('img', {
                              key: 'current-thumb',
                              className: 'sync-current-thumb',
                              src: currentProduct.imageUrl,
                              alt: currentProduct.title || 'Prodotto in sync'
                            })
                          : e('div', {
                              key: 'current-thumb-empty',
                              className: 'sync-current-thumb',
                              style: { display: 'grid', placeItems: 'center', color: '#8f8f99', fontSize: '10px' }
                            }, 'N/A'),
                        e('div', { key: 'current-text-wrap', style: { flex: 1 } }, [
                          e('p', { key: 'current-text', className: 'sync-current-text' },
                            'Sincronizzo ' + (currentProduct.title || 'prodotto')
                          ),
                          e('p', { key: 'current-meta', style: { margin: '4px 0 0', fontSize: '11px', color: '#9a9aa5' } },
                            (currentProduct.index || 0) + '/' + (currentProduct.total || sync.scanned || 0)
                          )
                        ])
                      ])
                    : null,
                  previousProduct
                    ? e('div', { key: 'divider', style: { borderTop: '1px solid #d0cec4', margin: '8px 0' } })
                    : null,
                  previousProduct
                    ? e('div', { key: 'previous-row', className: 'sync-current-row', style: { opacity: 0.85 } }, [
                        previousProduct.imageUrl
                          ? e('img', {
                              key: 'previous-thumb',
                              className: 'sync-current-thumb',
                              src: previousProduct.imageUrl,
                              alt: previousProduct.title || 'Prodotto precedente'
                            })
                          : e('div', {
                              key: 'previous-thumb-empty',
                              className: 'sync-current-thumb',
                              style: { display: 'grid', placeItems: 'center', color: '#8f8f99', fontSize: '10px' }
                            }, 'N/A'),
                        e('div', { key: 'previous-text-wrap', style: { flex: 1 } }, [
                          e('p', { key: 'previous-text', className: 'sync-current-text' },
                            '✓ ' + (previousProduct.title || 'prodotto')
                          ),
                          e('p', { key: 'previous-meta', style: { margin: '4px 0 0', fontSize: '11px', color: '#9a9aa5' } },
                            previousProduct.handle ? 'Handle: ' + previousProduct.handle : '-'
                          )
                        ])
                      ])
                    : null,
                  e('div', {
                    key: 'bar-bg',
                    style: {
                      width: '100%',
                      height: '10px',
                      background: '#efe6d4',
                      borderRadius: '999px',
                      overflow: 'hidden',
                      marginTop: previousProduct ? '8px' : '0'
                    }
                  }, e('div', {
                    style: {
                      width: progressPercent + '%',
                      height: '100%',
                      background: '#1f6f5f',
                      transition: 'width 200ms ease'
                    }
                  })),
                  e('div', { key: 'live-meta', className: 'sync-live-meta' }, [
                    e('span', { key: 'meta-1' }, 'Progresso: ' + progressPercent + '%'),
                    e('span', { key: 'meta-2' }, 'Processati: ' + (sync.processed || 0) + '/' + (sync.scanned || 0)),
                    e('span', { key: 'meta-3' }, 'Cambiati: ' + (sync.changed || 0)),
                    e('span', { key: 'meta-4' }, 'Invariati: ' + (sync.unchanged || 0)),
                    e('span', { key: 'meta-5' }, 'Errori: ' + (sync.errorsCount || 0))
                  ]),
                  recentProducts.length > 1
                    ? e('ul', { key: 'recent-list', className: 'sync-live-list' },
                        recentProducts.slice(1, 10).map(function (item, index) {
                          const name = item && item.title ? item.title : 'Prodotto';
                          return e('li', { key: 'recent-' + index }, '✓ ' + name);
                        })
                      )
                    : null
                ])
              : null;

            const completedPanel = (!sync.running && showLastReport && lastSyncReport)
              ? e('div', { key: 'completed-panel', className: 'sync-live-panel' }, [
                  e('p', { key: 'completed-title', className: 'sync-live-title' }, 'Sync completato'),
                  e('div', { key: 'completed-meta', className: 'sync-live-meta' }, [
                    e('span', { key: 'cm-1' }, 'Sincronizzati: ' + (lastSyncReport.synced || 0)),
                    e('span', { key: 'cm-2' }, 'Cambiati: ' + (lastSyncReport.changed || 0)),
                    e('span', { key: 'cm-3' }, 'Invariati: ' + (lastSyncReport.unchanged || 0)),
                    e('span', { key: 'cm-4' }, 'Errori: ' + ((lastSyncReport.errors && lastSyncReport.errors.length) || 0))
                  ]),
                  changedProducts.length
                    ? e('ul', { key: 'completed-list', className: 'sync-live-list' },
                        changedProducts.slice(0, 20).map(function (item, index) {
                          const label = item && item.title ? item.title : (item && item.handle ? item.handle : 'Prodotto');
                          return e('li', { key: 'changed-' + index }, label);
                        })
                      )
                    : e('p', { key: 'completed-empty', className: 'sync-current-text' }, 'Nessun prodotto modificato in quest\'ultimo sync.'),
                  e('div', { key: 'completed-actions', className: 'sync-live-actions' }, [
                    e('button', {
                      key: 'completed-dismiss',
                      type: 'button',
                      className: 'secondary',
                      onClick: dismissLastReport
                    }, 'Chiudi riepilogo')
                  ])
                ])
              : null;

            return e('div', { style: { display: 'grid', gap: '12px' } }, [
              e('button', {
                key: 'button',
                type: 'button',
                onClick: onStart,
                disabled: Boolean(sync.running),
                style: sync.running ? { opacity: 0.7, cursor: 'not-allowed' } : undefined
              }, sync.running ? '⟳ Sync in corso...' : '⟳ Avvia sync adesso'),
              livePanel,
              completedPanel,
              message ? e('p', { key: 'message', style: { margin: 0 } }, message) : null
            ]);
          }

          try {
            window.ReactDOM.createRoot(rootNode).render(e(SyncWidget));
            if (liveFallbackNode) {
              liveFallbackNode.style.display = 'none';
            }
            if (fallbackNode) {
              fallbackNode.style.display = 'none';
            }
          } catch (_error) {
            if (liveFallbackNode) {
              liveFallbackNode.style.display = '';
            }
            if (fallbackNode) {
              fallbackNode.style.display = '';
            }
            startFallbackPolling();
          }
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
  const render = async () => {
    try {
      await hydrateProductsFromShopifyIfNeeded();
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
  };

  render();
});

app.get('/app/state', (_req, res) => {
  const sendState = async () => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    await hydrateProductsFromShopifyIfNeeded();
    const state = stateStore.readState();
    res.json({
      state,
      sync: {
        running: isSyncRunning,
        startedAt: syncRuntime.startedAt,
        processed: Number(syncRuntime.processed || 0),
        scanned: Number(syncRuntime.scanned || 0),
        synced: Number(syncRuntime.synced || 0),
        changed: Number(syncRuntime.changed || 0),
        unchanged: Number(syncRuntime.unchanged || 0),
        currentProduct: syncRuntime.currentProduct || null,
        recentProducts: Array.isArray(syncRuntime.recentProducts) ? syncRuntime.recentProducts : [],
        skipped: Number(syncRuntime.skipped || 0),
        errorsCount: Number(syncRuntime.errorsCount || 0)
      }
    });
  };

  sendState().catch(error => {
    console.error('[HTTP] GET /app/state error:', error.message);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
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
let isHydratingProducts = false;
const syncRuntime = {
  startedAt: null,
  trigger: null,
  processed: 0,
  scanned: 0,
  synced: 0,
  changed: 0,
  unchanged: 0,
  currentProduct: null,
  recentProducts: [],
  skipped: 0,
  errorsCount: 0
};

async function hydrateProductsFromShopifyIfNeeded() {
  if (isHydratingProducts || isSyncRunning) {
    return;
  }

  const state = stateStore.readState();
  if (Object.keys(state.products || {}).length > 0) {
    return;
  }

  isHydratingProducts = true;
  try {
    const remoteProducts = await shopify.listAllProducts();
    const filteredProducts = remoteProducts.filter(product => hasCatalogTag(product.tags));

    if (!filteredProducts.length) {
      return;
    }

    const nextState = stateStore.readState();
    if (Object.keys(nextState.products || {}).length > 0) {
      return;
    }

    const markupPercent = Number(nextState.settings && nextState.settings.markupPercent
      ? nextState.settings.markupPercent
      : stateStore.getMarkupPercent());

    filteredProducts.forEach((product) => {
      const handle = String(product.handle || '').trim();
      if (!handle) {
        return;
      }

      nextState.products[handle] = productStateFromShopify(product, markupPercent);
    });

    stateStore.writeState(nextState);
    console.log(`[HYDRATE] Restored ${Object.keys(nextState.products).length} products from Shopify fallback.`);
  } catch (error) {
    console.error('[HYDRATE] Failed to restore products from Shopify:', error.message);
  } finally {
    isHydratingProducts = false;
  }
}

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
  syncRuntime.changed = 0;
  syncRuntime.unchanged = 0;
  syncRuntime.currentProduct = null;
  syncRuntime.recentProducts = [];
  syncRuntime.skipped = 0;
  syncRuntime.errorsCount = 0;

  setImmediate(async () => {
    try {
      console.log('[SYNC] starting', { trigger, startedAt: syncRuntime.startedAt });
      const report = await runCatalogSync({
        onProgress: progress => {
          console.log('[SYNC] progress', {
            processed: progress.processed,
            scanned: progress.scanned,
            currentProduct: progress.currentProduct ? progress.currentProduct.title : null
          });
          syncRuntime.processed = Number(progress.processed || 0);
          syncRuntime.scanned = Number(progress.scanned || 0);
          syncRuntime.synced = Number(progress.synced || 0);
          syncRuntime.changed = Number(progress.changed || 0);
          syncRuntime.unchanged = Number(progress.unchanged || 0);
          syncRuntime.currentProduct = progress.currentProduct || null;
          syncRuntime.recentProducts = Array.isArray(progress.recentProducts) ? progress.recentProducts : [];
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
      syncRuntime.changed = 0;
      syncRuntime.unchanged = 0;
      syncRuntime.currentProduct = null;
      syncRuntime.recentProducts = [];
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
