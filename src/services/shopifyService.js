const fs = require('fs');
const config = require('../config');
const stateStore = require('../store/stateStore');

function baseUrl() {
  return `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}`;
}

async function request(method, path, body) {
  const adminAccessToken = stateStore.getShopifyAdminAccessToken(config.shopify.storeDomain);
  if (!adminAccessToken) {
    throw new Error('Shopify store not connected yet. Complete the app authorization flow first.');
  }

  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminAccessToken
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`Shopify ${method} ${path} failed (${response.status}): ${text}`);
  }

  return parsed;
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
