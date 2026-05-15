function cleanValue(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function slugify(text) {
  return cleanValue(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function parseMoney(value) {
  const cleaned = cleanValue(value);
  const match = cleaned.match(/^([^\d-]*)([\d.,]+)$/);

  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[2].replace(/,/g, ''));
  if (Number.isNaN(amount)) {
    return null;
  }

  return {
    symbol: cleanValue(match[1]),
    amount
  };
}

function applyMarkup(amount, markupPercent) {
  return Number((amount * (1 + markupPercent / 100)).toFixed(2));
}

module.exports = {
  cleanValue,
  slugify,
  parseMoney,
  applyMarkup
};
