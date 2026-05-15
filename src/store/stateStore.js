const fs = require('fs');
const path = require('path');
const config = require('../config');

const stateBackupFile = `${config.paths.stateFile}.bak`;

const DEFAULT_STATE = {
  settings: {
    markupPercent: config.pricing.defaultMarkupPercent
  },
  shopifyAuth: {
    installations: {},
    pendingStates: {}
  },
  products: {},
  lastSync: null
};

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function normalizeShopDomain(shopDomain) {
  return String(shopDomain || '').trim().toLowerCase();
}

function ensureStateFile() {
  try {
    const dir = path.dirname(config.paths.stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(config.paths.stateFile)) {
      fs.writeFileSync(config.paths.stateFile, JSON.stringify(DEFAULT_STATE, null, 2), 'utf8');
    }

    if (!fs.existsSync(stateBackupFile)) {
      fs.writeFileSync(stateBackupFile, JSON.stringify(DEFAULT_STATE, null, 2), 'utf8');
    }
  } catch (error) {
    console.error('[STATE] Failed to ensure state file:', error.message);
    throw error;
  }
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeState(parsed) {
  return {
    ...DEFAULT_STATE,
    ...parsed,
    settings: {
      ...DEFAULT_STATE.settings,
      ...(parsed.settings || {})
    },
    shopifyAuth: {
      ...DEFAULT_STATE.shopifyAuth,
      ...(parsed.shopifyAuth || {}),
      installations: {
        ...DEFAULT_STATE.shopifyAuth.installations,
        ...((parsed.shopifyAuth && parsed.shopifyAuth.installations) || {})
      },
      pendingStates: {
        ...DEFAULT_STATE.shopifyAuth.pendingStates,
        ...((parsed.shopifyAuth && parsed.shopifyAuth.pendingStates) || {})
      }
    },
    products: parsed.products || {}
  };
}

function readState() {
  try {
    ensureStateFile();
    const parsed = readJsonFile(config.paths.stateFile);
    return normalizeState(parsed);
  } catch (error) {
    try {
      const backupParsed = readJsonFile(stateBackupFile);
      const normalized = normalizeState(backupParsed);
      writeState(normalized);
      console.warn('[STATE] Recovered state from backup file due to primary read failure.');
      return normalized;
    } catch (backupError) {
      console.error('[STATE] Failed to read state and backup, returning defaults:', error.message, backupError.message);
      return cloneDefaultState();
    }
  }
}

function writeState(nextState) {
  const dir = path.dirname(config.paths.stateFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload = JSON.stringify(nextState, null, 2);
  const tmpFile = `${config.paths.stateFile}.tmp`;

  // Write to a temp file first to avoid partial writes corrupting the state file.
  fs.writeFileSync(tmpFile, payload, 'utf8');
  fs.renameSync(tmpFile, config.paths.stateFile);

  // Keep a backup copy for recovery if the primary file ever becomes invalid.
  fs.writeFileSync(stateBackupFile, payload, 'utf8');
}

function getMarkupPercent() {
  const state = readState();
  return Number(state.settings.markupPercent || 0);
}

function setMarkupPercent(markupPercent) {
  const state = readState();
  state.settings.markupPercent = Number(markupPercent);
  writeState(state);
  return state.settings.markupPercent;
}

function setShopifyInstallation(shopDomain, installation) {
  const state = readState();
  const key = normalizeShopDomain(shopDomain);
  if (!key) {
    throw new Error('Shop domain non valido durante il salvataggio OAuth.');
  }

  state.shopifyAuth.installations[key] = {
    ...(state.shopifyAuth.installations[key] || {}),
    ...installation,
    updatedAt: new Date().toISOString()
  };
  writeState(state);

  const persisted = getShopifyInstallation(key);
  if (!persisted || !persisted.adminAccessToken) {
    throw new Error('Impossibile salvare il token OAuth nello stato persistente. Verifica DATA_DIR/volume.');
  }

  return state.shopifyAuth.installations[key];
}

function getShopifyInstallation(shopDomain) {
  const state = readState();
  const key = normalizeShopDomain(shopDomain);
  if (!key) {
    return null;
  }

  const direct = state.shopifyAuth.installations[key] || null;
  if (direct) {
    return direct;
  }

  // Fallback: if there is exactly one installation saved, reuse it.
  const installationKeys = Object.keys(state.shopifyAuth.installations || {});
  if (installationKeys.length === 1) {
    return state.shopifyAuth.installations[installationKeys[0]] || null;
  }

  return null;
}

function getShopifyAdminAccessToken(shopDomain) {
  const installation = getShopifyInstallation(shopDomain);
  return (installation && installation.adminAccessToken) || config.shopify.adminAccessToken || '';
}

function createPendingOAuthState(nonce, shopDomain) {
  const state = readState();
  state.shopifyAuth.pendingStates[nonce] = {
    shopDomain: normalizeShopDomain(shopDomain),
    createdAt: new Date().toISOString()
  };
  writeState(state);
}

function consumePendingOAuthState(nonce) {
  const state = readState();
  const pendingState = state.shopifyAuth.pendingStates[nonce] || null;
  delete state.shopifyAuth.pendingStates[nonce];
  writeState(state);
  return pendingState;
}

module.exports = {
  readState,
  writeState,
  getMarkupPercent,
  setMarkupPercent,
  setShopifyInstallation,
  getShopifyInstallation,
  getShopifyAdminAccessToken,
  createPendingOAuthState,
  consumePendingOAuthState
};
