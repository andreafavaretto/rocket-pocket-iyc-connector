const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', '..', 'data');
const imageDir = path.resolve(dataDir, 'images');
const stateFile = path.resolve(dataDir, 'state.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(imageDir)) {
  fs.mkdirSync(imageDir, { recursive: true });
}

module.exports = {
  server: {
    port: Number(process.env.PORT || 8787),
    backendApiKey: required('BACKEND_API_KEY')
  },
  google: {
    sheetId: required('GOOGLE_SHEET_ID'),
    gid: process.env.GOOGLE_SHEET_GID || '0'
  },
  shopify: {
    storeDomain: required('SHOPIFY_STORE_DOMAIN'),
    adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '',
    clientId: process.env.SHOPIFY_API_KEY || process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_CLIENT_SECRET || '',
    accessScopes: process.env.SHOPIFY_ACCESS_SCOPES || 'read_products,write_products',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
    vendor: process.env.SHOPIFY_VENDOR || 'IYC',
    catalogTag: process.env.SHOPIFY_PRODUCT_TAG || 'iyc-catalog'
  },
  pricing: {
    defaultCurrency: process.env.DEFAULT_PRICE_CURRENCY || 'GBP (£)',
    defaultMarkupPercent: Number(process.env.DEFAULT_MARKUP_PERCENT || 0)
  },
  sync: {
    cron: process.env.SYNC_CRON || '*/30 * * * *'
  },
  paths: {
    dataDir,
    imageDir,
    stateFile
  }
};
