const path = require('path');
const JSZip = require('jszip');
const config = require('../config');
const { parsePriceGuide } = require('../utils/csv');
const { cleanValue } = require('../utils/text');
const { saveImageToCache } = require('../utils/fsCache');

function buildCsvUrl() {
  return `https://docs.google.com/spreadsheets/d/${config.google.sheetId}/export?format=csv&gid=${config.google.gid}`;
}

function buildXlsxUrl() {
  return `https://docs.google.com/spreadsheets/d/${config.google.sheetId}/export?format=xlsx&gid=${config.google.gid}`;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseRelationshipsXml(relsXml) {
  const relMap = {};
  const relRegex = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  let match = relRegex.exec(relsXml);

  while (match) {
    relMap[match[1]] = match[2];
    match = relRegex.exec(relsXml);
  }

  return relMap;
}

function resolveZipPath(basePath, relativePath) {
  if (relativePath.startsWith('xl/')) {
    return relativePath;
  }

  const parts = basePath.split('/');
  parts.pop();

  const segments = relativePath.replace(/^\/+/, '').split('/');
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  return parts.join('/');
}

function extensionFromPath(filePath) {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  if (ext === 'jpeg') {
    return 'jpg';
  }
  return ext || 'png';
}

function extractAnchors(drawingXml) {
  const anchors = [];
  const anchorRegex = /<(?:xdr:)?(?:twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/(?:xdr:)?(?:twoCellAnchor|oneCellAnchor)>/g;
  let anchorMatch = anchorRegex.exec(drawingXml);

  while (anchorMatch) {
    const block = anchorMatch[0];
    const fromBlockMatch = block.match(/<(?:xdr:)?from>([\s\S]*?)<\/(?:xdr:)?from>/);
    const fromBlock = fromBlockMatch ? fromBlockMatch[1] : '';
    const rowMatch = fromBlock.match(/<(?:xdr:)?row>(\d+)<\/(?:xdr:)?row>/);
    const colMatch = fromBlock.match(/<(?:xdr:)?col>(\d+)<\/(?:xdr:)?col>/);
    const relMatch = block.match(/(?:r:embed|embed)="([^"]+)"/);

    if (rowMatch && colMatch && relMatch) {
      anchors.push({
        row: Number(rowMatch[1]),
        col: Number(colMatch[1]),
        relationId: relMatch[1]
      });
    }

    anchorMatch = anchorRegex.exec(drawingXml);
  }

  return anchors;
}

async function loadImageMapFromXlsx() {
  const xlsxBuffer = await fetchBuffer(buildXlsxUrl());
  const zip = await JSZip.loadAsync(xlsxBuffer);

  const drawingPath = 'xl/drawings/drawing1.xml';
  const relsPath = 'xl/drawings/_rels/drawing1.xml.rels';
  const drawingFile = zip.file(drawingPath);
  const relsFile = zip.file(relsPath);

  if (!drawingFile || !relsFile) {
    return {};
  }

  const drawingXml = await drawingFile.async('string');
  const relsXml = await relsFile.async('string');

  const anchors = extractAnchors(drawingXml);
  const relMap = parseRelationshipsXml(relsXml);
  const imageMap = {};

  for (const anchor of anchors) {
    if (anchor.col !== 1) {
      continue;
    }

    const relativeTarget = relMap[anchor.relationId];
    if (!relativeTarget) {
      continue;
    }

    const zipPath = resolveZipPath(drawingPath, relativeTarget);
    const mediaFile = zip.file(zipPath);
    if (!mediaFile) {
      continue;
    }

    const imageBuffer = Buffer.from(await mediaFile.async('nodebuffer'));
    const extension = extensionFromPath(zipPath);
    const cached = saveImageToCache(config.paths.imageDir, imageBuffer, extension);
    const sheetRow = anchor.row + 1;

    if (!imageMap[sheetRow]) {
      imageMap[sheetRow] = cached;
    }
  }

  return imageMap;
}

function getImageForProductRow(imageMap, sheetRow) {
  return imageMap[sheetRow] || imageMap[sheetRow - 1] || imageMap[sheetRow - 2] || null;
}

async function loadCatalog() {
  const csvText = await fetchText(buildCsvUrl());
  const products = parsePriceGuide(csvText);
  const imageMap = await loadImageMapFromXlsx();

  return products.map(product => ({
    ...product,
    image: getImageForProductRow(imageMap, product.sheetRow),
    fallbackImageUrl: /^https?:\/\//i.test(cleanValue(product.image)) ? product.image : ''
  }));
}

module.exports = {
  loadCatalog
};
