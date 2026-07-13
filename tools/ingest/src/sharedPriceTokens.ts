export interface ParsedSharedPricePair {
  name: string;
  priceYen: number;
  nameTokenIndex: number;
  priceTokenIndexes: number[];
  consumedTokenIndexes: number[];
}

/** Parses name+yen-price cells without applying location or dish-name rules. */
export function parseSharedPricePairs(tokens: readonly string[]): ParsedSharedPricePair[] {
  const pairs: ParsedSharedPricePair[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = normalizePriceToken(tokens[index]);
    const markerIndex = token.search(/[¥\\]/);
    if (markerIndex < 0) continue;

    const name = token.slice(0, markerIndex).trim();
    let priceText = token.slice(markerIndex + 1).replace(/\D/g, "");
    const priceTokenIndexes = [index];
    let lastIndex = index;
    while (lastIndex + 1 < tokens.length && isDigitToken(tokens[lastIndex + 1])) {
      lastIndex += 1;
      priceText += normalizePriceToken(tokens[lastIndex]).replace(/\D/g, "");
      priceTokenIndexes.push(lastIndex);
      if (priceText.length > 5) break;
    }

    if (!name || !/^\d{2,5}$/.test(priceText)) continue;
    pairs.push({
      name,
      priceYen: Number(priceText),
      nameTokenIndex: index,
      priceTokenIndexes,
      consumedTokenIndexes: Array.from({ length: lastIndex - index + 1 }, (_, offset) => index + offset)
    });
    index = lastIndex;
  }
  return pairs;
}

export function normalizePriceToken(text: string): string {
  return text.normalize("NFKC").replace(/￥/g, "¥").trim();
}

function isDigitToken(text: string): boolean {
  return /^\d+$/.test(normalizePriceToken(text));
}
