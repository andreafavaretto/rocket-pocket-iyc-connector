const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function saveImageToCache(imageDir, buffer, extension) {
  ensureDir(imageDir);
  const hash = sha1(buffer);
  const fileName = `${hash}.${extension}`;
  const filePath = path.resolve(imageDir, fileName);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }

  return {
    hash,
    fileName,
    filePath
  };
}

module.exports = {
  saveImageToCache
};
