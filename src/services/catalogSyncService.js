const config = require('../config');
const stateStore = require('../store/stateStore');
const { loadCatalog } = require('./googleSheetsService');
const shopify = require('./shopifyService');
const { slugify, parseMoney, applyMarkup } = require('../utils/text');

function pickPriceForCurrency(prices, preferredCurrency) {
  if (!Array.isArray(prices) || !prices.length) {
    return null;
  }

  const exact = prices.find(price => price.currency === preferredCurrency);
  return exact || prices[0];
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

  const parsed = parseMoney(selectedPrice.casePrice);
  if (!parsed) {
    return null;
  }

  const finalPrice = applyMarkup(parsed.amount, markupPercent);

  return {
    handle,
    title: product.name,
    body_html: product.details || '',
    vendor: config.shopify.vendor,
    tags: [config.shopify.catalogTag].filter(Boolean).join(','),
    variantPrice: finalPrice.toFixed(2),
    variantSku: handle.toUpperCase(),
    image: product.image || null,
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
      status: 'active',
      variants: [
        {
          price: productPayload.variantPrice,
          sku: productPayload.variantSku,
          inventory_management: null,
          inventory_policy: 'continue'
        }
      ]
    };

    syncedProduct = await shopify.createProduct(createPayload);
  } else {
    const firstVariant = existing.variants && existing.variants.length ? existing.variants[0] : null;
    const updatePayload = {
      id: existing.id,
      title: productPayload.title,
      body_html: productPayload.body_html,
      vendor: productPayload.vendor,
      tags: productPayload.tags,
      variants: firstVariant
        ? [
            {
              id: firstVariant.id,
              price: productPayload.variantPrice,
              sku: productPayload.variantSku
            }
          ]
        : undefined
    };

    syncedProduct = await shopify.updateProduct(existing.id, updatePayload);
  }

  const imageHash = productPayload.image ? productPayload.image.hash : null;
  const needsImageSync = imageHash && previousState.imageHash !== imageHash;

  if (needsImageSync) {
    await shopify.addOrReplaceProductImage(syncedProduct.id, productPayload.image);
  }

  return {
    shopifyProductId: syncedProduct.id,
    imageHash,
    lastPrice: productPayload.variantPrice,
    sourceCurrency: productPayload.sourceCurrency
  };
}

async function runCatalogSync() {
  const startedAt = new Date().toISOString();
  const state = stateStore.readState();
  const markupPercent = Number(state.settings.markupPercent || 0);

  const catalogProducts = await loadCatalog();
  const summary = {
    startedAt,
    markupPercent,
    scanned: catalogProducts.length,
    synced: 0,
    skipped: 0,
    errors: []
  };

  for (const product of catalogProducts) {
    try {
      const payload = ensureProductPayload(product, markupPercent);
      if (!payload) {
        summary.skipped += 1;
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
    } catch (error) {
      summary.errors.push({ productName: product.name, message: error.message });
    }
  }

  state.lastSync = {
    ...summary,
    finishedAt: new Date().toISOString()
  };

  stateStore.writeState(state);
  return state.lastSync;
}

module.exports = {
  runCatalogSync
};
