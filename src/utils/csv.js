const { cleanValue } = require('./text');

function parseCSVRows(csvText) {
  const rows = [];
  let row = [];
  let value = '';
  let insideQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const nextChar = csvText[index + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        value += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === ',' && !insideQuotes) {
      row.push(value);
      value = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        index += 1;
      }
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }

    value += char;
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function parsePriceGuide(csvText) {
  const rows = parseCSVRows(csvText);
  const products = [];
  let currentProduct = null;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const sheetRow = rowIndex + 1;

    const firstCell = cleanValue(row[0]);
    const currency = cleanValue(row[3]);
    const casePrice = cleanValue(row[4]);

    if (!firstCell && !currency && !casePrice) {
      continue;
    }

    if (firstCell === 'Item Name') {
      continue;
    }

    const isProductRow = firstCell && currency && casePrice;
    const isCurrencyContinuation = !firstCell && currency && casePrice && currentProduct;

    if (isProductRow) {
      currentProduct = {
        sheetRow,
        name: firstCell,
        image: cleanValue(row[1]),
        rmb: cleanValue(row[2]),
        unitsPerCase: cleanValue(row[5]),
        unitPrice: cleanValue(row[6]),
        details: cleanValue(row[7]),
        shipping: [cleanValue(row[8]), cleanValue(row[10])].filter(Boolean),
        prices: []
      };

      products.push(currentProduct);
    }

    if (isProductRow || isCurrencyContinuation) {
      currentProduct.prices.push({
        currency,
        casePrice,
        unitPrice: cleanValue(row[6]) || currentProduct.unitPrice
      });
    }
  }

  return products.filter(product => product.name && product.prices.length);
}

module.exports = {
  parsePriceGuide
};
