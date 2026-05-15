const fs = require('fs');
const config = require('../config');
const stateStore = require('../store/stateStore');

const MIN_REQUEST_INTERVAL_MS = Number(process.env.SHOPIFY_MIN_REQUEST_INTERVAL_MS || 550);
const MAX_RATE_LIMIT_RETRIES = Number(process.env.SHOPIFY_MAX_RATE_LIMIT_RETRIES || 5);

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

function baseUrl() {
  return `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseResponseBody(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function getRetryDelayMs(response, attempt) {
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.ceil(retryAfterSeconds * 1000);
  }

  return MIN_REQUEST_INTERVAL_MS * (attempt + 2);
}

function enqueueRequest(task) {
  const run = requestQueue.then(async () => {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    }

    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });

  requestQueue = run.catch(() => undefined);
  return run;
}

async function request(method, path, body) {
  const adminAccessToken = stateStore.getShopifyAdminAccessToken(config.shopify.storeDomain);
  if (!adminAccessToken) {
    throw new Error('Shopify store not connected yet. Complete the app authorization flow first.');
  }

  return enqueueRequest(async () => {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const response = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': adminAccessToken
        },
        body: body ? JSON.stringify(body) : undefined
      });

      const text = await response.text();
      const parsed = parseResponseBody(text);

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(getRetryDelayMs(response, attempt));
        continue;
      }

      if (!response.ok) {
        const errorText = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        throw new Error(`Shopify ${method} ${path} failed (${response.status}): ${errorText}`);
      }

      return parsed;
    }

    throw new Error(`Shopify ${method} ${path} failed after ${MAX_RATE_LIMIT_RETRIES + 1} attempts due to rate limiting.`);
  });
}

async function findProductByHandle(handle) {
  const data = await request('GET', `/products.json?handle=${encodeURIComponent(handle)}&limit=1`);
  return data.products && data.products.length ? data.products[0] : null;
}

async function createProduct(productPayload) {
  const data = await request('POST', '/products.json', { product: productPayload });
  return data.product;
}

async function updateProduct(productId, productPayload) {
  const data = await request('PUT', `/products/${productId}.json`, { product: productPayload });
  return data.product;
}

async function addOrReplaceProductImage(productId, imageInfo) {
  const attachment = fs.readFileSync(imageInfo.filePath).toString('base64');
  const payload = {
    image: {
      attachment,
      filename: imageInfo.fileName,
      alt: 'IYC product image'
    }
  };

  const data = await request('POST', `/products/${productId}/images.json`, payload);
  return data.image;
}

module.exports = {
  findProductByHandle,
  createProduct,
  updateProduct,
  addOrReplaceProductImage
};
