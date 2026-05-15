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

function formatMoney(symbol, amount) {
  if (!Number.isFinite(amount)) {
    return null;
  }

  const normalizedSymbol = String(symbol || '').trim();
  return normalizedSymbol ? `${normalizedSymbol}${amount.toFixed(2)}` : amount.toFixed(2);
}

function areEqualPricingRows(left, right) {
  const leftRows = Array.isArray(left) ? left : [];
  const rightRows = Array.isArray(right) ? right : [];
  return JSON.stringify(leftRows) === JSON.stringify(rightRows);
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

  const pricingByCurrency = Array.isArray(product.prices)
    ? product.prices
        .map((priceRow) => {
          const parsedRowCasePrice = parseMoney(priceRow.casePrice);
          if (!parsedRowCasePrice) {
            return null;
          }

          const parsedRowUnitPrice = parseMoney(priceRow.unitPrice);
          const computedRowUnitAmount = unitsPerCase ? parsedRowCasePrice.amount / unitsPerCase : null;
          const originalUnitAmount = parsedRowUnitPrice
            ? parsedRowUnitPrice.amount
            : Number.isFinite(computedRowUnitAmount)
              ? computedRowUnitAmount
              : null;

          const unitSymbol = parsedRowUnitPrice ? parsedRowUnitPrice.symbol : parsedRowCasePrice.symbol;
          const markedUpCaseAmount = applyMarkup(parsedRowCasePrice.amount, markupPercent);
          const markedUpUnitAmount = Number.isFinite(originalUnitAmount)
            ? applyMarkup(originalUnitAmount, markupPercent)
            : null;

          return {
            currency: priceRow.currency || '-',
            caseOriginal: formatMoney(parsedRowCasePrice.symbol, parsedRowCasePrice.amount),
            caseMarkedUp: formatMoney(parsedRowCasePrice.symbol, markedUpCaseAmount),
            unitOriginal: formatMoney(unitSymbol, originalUnitAmount),
            unitMarkedUp: formatMoney(unitSymbol, markedUpUnitAmount)
          };
        })
        .filter(Boolean)
    : [];

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
    sourceCurrency: selectedPrice.currency,
    pricingByCurrency,
    markupPercentApplied: markupPercent
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

  const nextState = {
    shopifyProductId: syncedProduct.id,
    imageHash,
    imageFileName: productPayload.image ? productPayload.image.fileName : null,
    lastPrice: (caseVariant || productPayload.variants[0]).price,
    lastCasePrice: caseVariant ? caseVariant.price : null,
    lastBoxPrice: boxVariant ? boxVariant.price : null,
    sourceCurrency: productPayload.sourceCurrency,
    pricingByCurrency: Array.isArray(productPayload.pricingByCurrency) ? productPayload.pricingByCurrency : [],
    markupPercentApplied: Number(productPayload.markupPercentApplied || 0)
  };

  const changedFields = [];
  if (!previousState.shopifyProductId || String(previousState.shopifyProductId) !== String(nextState.shopifyProductId)) {
    changedFields.push('shopifyProductId');
  }
  if (String(previousState.imageHash || '') !== String(nextState.imageHash || '')) {
    changedFields.push('imageHash');
  }
  if (String(previousState.lastPrice || '') !== String(nextState.lastPrice || '')) {
    changedFields.push('lastPrice');
  }
  if (String(previousState.lastCasePrice || '') !== String(nextState.lastCasePrice || '')) {
    changedFields.push('lastCasePrice');
  }
  if (String(previousState.lastBoxPrice || '') !== String(nextState.lastBoxPrice || '')) {
    changedFields.push('lastBoxPrice');
  }
  if (String(previousState.sourceCurrency || '') !== String(nextState.sourceCurrency || '')) {
    changedFields.push('sourceCurrency');
  }
  if (Number(previousState.markupPercentApplied || 0) !== Number(nextState.markupPercentApplied || 0)) {
    changedFields.push('markupPercentApplied');
  }
  if (!areEqualPricingRows(previousState.pricingByCurrency, nextState.pricingByCurrency)) {
    changedFields.push('pricingByCurrency');
  }

  return {
    ...nextState,
    didChange: changedFields.length > 0,
    changedFields
  };
}

async function runCatalogSync(options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const startedAt = new Date().toISOString();
  const state = stateStore.readState();
  const markupPercent = Number(state.settings.markupPercent || 0);

  const catalogProducts = await loadCatalog();
  console.log('[CATALOG] loaded', { count: catalogProducts.length, startedAt });
  const summary = {
    startedAt,
    markupPercent,
    scanned: catalogProducts.length,
    processed: 0,
    synced: 0,
    changed: 0,
    unchanged: 0,
    currentProduct: null,
    recentProducts: [],
    changedProducts: [],
    skipped: 0,
    errors: []
  };

  if (onProgress) {
    console.log('[CATALOG] calling onProgress with initial summary', { scanned: summary.scanned });
    onProgress({ ...summary, errorsCount: 0, stage: 'running' });
  }

  for (let index = 0; index < catalogProducts.length; index += 1) {
    const product = catalogProducts[index];
    const productHandle = buildHandle(product.name) || '';
    const productImageUrl = product && product.image && product.image.fileName
      ? `/images/${encodeURIComponent(product.image.fileName)}`
      : String(product.fallbackImageUrl || '');

    summary.currentProduct = {
      title: product.name || '-',
      handle: productHandle,
      index: index + 1,
      total: catalogProducts.length,
      imageUrl: productImageUrl
    };

    if (onProgress) {
      onProgress({ ...summary, errorsCount: summary.errors.length, stage: 'running' });
    }

    try {
      const payload = ensureProductPayload(product, markupPercent);
      if (!payload) {
        summary.skipped += 1;
        summary.processed = index + 1;
        summary.recentProducts = [
          {
            title: product.name || '-',
            handle: productHandle,
            status: 'skipped'
          },
          ...summary.recentProducts
        ].slice(0, 10);
        if (onProgress) {
          onProgress({ ...summary, errorsCount: summary.errors.length, stage: 'running' });
        }
        continue;
      }

      const previous = state.products[payload.handle] || {};
      const next = await upsertProduct(payload, previous);
      const { didChange, changedFields, ...persistedNext } = next;

      state.products[payload.handle] = {
        ...previous,
        ...persistedNext,
        title: payload.title,
        updatedAt: new Date().toISOString()
      };

      summary.synced += 1;
      if (didChange) {
        summary.changed += 1;
        summary.changedProducts.push({
          title: payload.title,
          handle: payload.handle,
          casePrice: persistedNext.lastCasePrice,
          boxPrice: persistedNext.lastBoxPrice,
          sourceCurrency: persistedNext.sourceCurrency,
          changedFields
        });
        summary.recentProducts = [
          {
            title: payload.title,
            handle: payload.handle,
            status: 'changed'
          },
          ...summary.recentProducts
        ].slice(0, 10);
      } else {
        summary.unchanged += 1;
        summary.recentProducts = [
          {
            title: payload.title,
            handle: payload.handle,
            status: 'unchanged'
          },
          ...summary.recentProducts
        ].slice(0, 10);
      }
      summary.processed = index + 1;
    } catch (error) {
      summary.errors.push({ productName: product.name, message: error.message });
      summary.processed = index + 1;
      summary.recentProducts = [
        {
          title: product.name || '-',
          handle: productHandle,
          status: 'error'
        },
        ...summary.recentProducts
      ].slice(0, 10);
    }

    if (onProgress) {
      onProgress({ ...summary, errorsCount: summary.errors.length, stage: 'running' });
    }
  }

  state.lastSync = {
    ...summary,
    currentProduct: null,
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
