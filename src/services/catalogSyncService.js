const config = require('../config');
const stateStore = require('../store/stateStore');
const { loadCatalog } = require('./googleSheetsService');
const shopify = require('./shopifyService');
const { slugify, parseMoney, applyMarkup } = require('../utils/text');

function parseUnitsPerCase(value) {
  const cleaned = String(value || '').trim();
  const match = cleaned.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeVariantKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCurrency(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function currencyAliases(value) {
  const normalized = normalizeCurrency(value);
  if (!normalized) {
    return [];
  }

  const aliases = new Set([normalized]);

  if (normalized.includes('EUR') || normalized.includes('€')) {
    aliases.add('EUR');
    aliases.add('EUR (€)');
    aliases.add('€');
  }

  if (normalized.includes('GBP') || normalized.includes('£')) {
    aliases.add('GBP');
    aliases.add('GBP (£)');
    aliases.add('£');
  }

  if (normalized.includes('USD') || normalized.includes('$')) {
    aliases.add('USD');
    aliases.add('USD ($)');
    aliases.add('$');
  }

  return Array.from(aliases);
}

function pickPriceForCurrency(prices, preferredCurrency) {
  if (!Array.isArray(prices) || !prices.length) {
    return null;
  }

  const preferredAliases = currencyAliases(preferredCurrency);
  const normalizedRows = prices.map(price => ({
    ...price,
    normalizedCurrency: normalizeCurrency(price.currency)
  }));

  const exact = normalizedRows.find(price => preferredAliases.includes(price.normalizedCurrency));
  if (exact) {
    return exact;
  }

  const containsAlias = normalizedRows.find(price =>
    preferredAliases.some(alias => price.normalizedCurrency.includes(alias))
  );
  if (containsAlias) {
    return containsAlias;
  }

  return prices[0];
}

function buildHandle(name) {
  const slug = slugify(name);
  return slug ? `iyc-${slug}` : null;
}

function ensureProductPayload(product, markupPercent) {
  const handle = buildHandle(product.name);
  if (!handle) {
    return null;
  }

  const selectedPrice = pickPriceForCurrency(product.prices, config.pricing.defaultCurrency);
  if (!selectedPrice) {
    return null;
  }

  const parsedCasePrice = parseMoney(selectedPrice.casePrice);
  if (!parsedCasePrice) {
    return null;
  }

  const unitsPerCase = parseUnitsPerCase(product.unitsPerCase);
  const parsedUnitPrice = parseMoney(selectedPrice.unitPrice);
  const computedUnitAmount = unitsPerCase ? parsedCasePrice.amount / unitsPerCase : null;
  const unitAmount = parsedUnitPrice
    ? parsedUnitPrice.amount
    : Number.isFinite(computedUnitAmount)
      ? computedUnitAmount
      : null;

  const variants = [];

  if (Number.isFinite(unitAmount) && unitAmount > 0) {
    variants.push({
      title: 'Box',
      price: applyMarkup(unitAmount, markupPercent).toFixed(2),
      sku: `${handle.toUpperCase()}-BOX`
    });
  }

  const caseTitle = unitsPerCase
    ? `Case (${Number.isInteger(unitsPerCase) ? unitsPerCase : unitsPerCase.toFixed(2)} Box)`
    : 'Case';

  variants.push({
    title: caseTitle,
    price: applyMarkup(parsedCasePrice.amount, markupPercent).toFixed(2),
    sku: `${handle.toUpperCase()}-CASE`
  });

  return {
    handle,
    title: product.name,
    body_html: product.details || '',
    vendor: config.shopify.vendor,
    tags: [config.shopify.catalogTag].filter(Boolean).join(','),
    variants,
    image: product.image || null,
    unitsPerCase,
    sourceCurrency: selectedPrice.currency
  };
}

async function upsertProduct(productPayload, previousState) {
  const existing = await shopify.findProductByHandle(productPayload.handle);
  let syncedProduct;

  if (!existing) {
    const createPayload = {
      title: productPayload.title,
      body_html: productPayload.body_html,
      handle: productPayload.handle,
      vendor: productPayload.vendor,
      tags: productPayload.tags,
      options: [
        {
          name: 'Formato'
        }
      ],
      status: 'active',
      variants: productPayload.variants.map(variant => ({
        option1: variant.title,
        price: variant.price,
        sku: variant.sku,
        inventory_management: null,
        inventory_policy: 'continue'
      }))
    };

    syncedProduct = await shopify.createProduct(createPayload);
  } else {
    const existingVariantsByKey = new Map(
      (existing.variants || []).map(variant => [
        normalizeVariantKey(variant.option1 || variant.title),
        variant
      ])
    );

    const updatePayload = {
      id: existing.id,
      title: productPayload.title,
      body_html: productPayload.body_html,
      vendor: productPayload.vendor,
      tags: productPayload.tags,
      options: [
        {
          name: 'Formato'
        }
      ],
      variants: productPayload.variants.map(variant => {
        const current = existingVariantsByKey.get(normalizeVariantKey(variant.title));
        return {
          ...(current && current.id ? { id: current.id } : {}),
          option1: variant.title,
          price: variant.price,
          sku: variant.sku,
          inventory_management: null,
          inventory_policy: 'continue'
        };
      })
    };

    syncedProduct = await shopify.updateProduct(existing.id, updatePayload);
  }

  const imageHash = productPayload.image ? productPayload.image.hash : null;
  const needsImageSync = imageHash && previousState.imageHash !== imageHash;

  if (needsImageSync) {
    await shopify.addOrReplaceProductImage(syncedProduct.id, productPayload.image);
  }

  const caseVariant = productPayload.variants.find(variant => normalizeVariantKey(variant.title).startsWith('case'));
  const boxVariant = productPayload.variants.find(variant => normalizeVariantKey(variant.title) === 'box');

  return {
    shopifyProductId: syncedProduct.id,
    imageHash,
    imageFileName: productPayload.image ? productPayload.image.fileName : null,
    lastPrice: (caseVariant || productPayload.variants[0]).price,
    lastCasePrice: caseVariant ? caseVariant.price : null,
    lastBoxPrice: boxVariant ? boxVariant.price : null,
    sourceCurrency: productPayload.sourceCurrency
  };
}

async function runCatalogSync(options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const startedAt = new Date().toISOString();
  const state = stateStore.readState();
  const markupPercent = Number(state.settings.markupPercent || 0);

  const catalogProducts = await loadCatalog();
  const summary = {
    startedAt,
    markupPercent,
    scanned: catalogProducts.length,
    processed: 0,
    synced: 0,
    skipped: 0,
    errors: []
  };

  if (onProgress) {
    onProgress({ ...summary, errorsCount: 0, stage: 'running' });
  }

  for (let index = 0; index < catalogProducts.length; index += 1) {
    const product = catalogProducts[index];
    try {
      const payload = ensureProductPayload(product, markupPercent);
      if (!payload) {
        summary.skipped += 1;
        summary.processed = index + 1;
        if (onProgress) {
          onProgress({ ...summary, errorsCount: summary.errors.length, stage: 'running' });
        }
        continue;
      }

      const previous = state.products[payload.handle] || {};
      const next = await upsertProduct(payload, previous);

      state.products[payload.handle] = {
        ...previous,
        ...next,
        title: payload.title,
        updatedAt: new Date().toISOString()
      };

      summary.synced += 1;
      summary.processed = index + 1;
    } catch (error) {
      summary.errors.push({ productName: product.name, message: error.message });
      summary.processed = index + 1;
    }

    if (onProgress) {
      onProgress({ ...summary, errorsCount: summary.errors.length, stage: 'running' });
    }
  }

  state.lastSync = {
    ...summary,
    finishedAt: new Date().toISOString()
  };

  if (onProgress) {
    onProgress({ ...state.lastSync, errorsCount: state.lastSync.errors.length, stage: 'completed' });
  }

  stateStore.writeState(state);
  return state.lastSync;
}

module.exports = {
  runCatalogSync
};
