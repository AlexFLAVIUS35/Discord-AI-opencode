const MAX_ENUMERATION_COUNT = 9_999;

function parseCount(value: string): number | null {
  const normalized = value
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/_/g, '')
    .trim();

  const match = normalized.match(/^(\d+(?:\.\d+)?)(k|m|million|b|billion|t|trillion)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const multiplier = {
    k: 1_000,
    m: 1_000_000,
    million: 1_000_000,
    b: 1_000_000_000,
    billion: 1_000_000_000,
    t: 1_000_000_000_000,
    trillion: 1_000_000_000_000,
  }[match[2] ?? ''] ?? 1;

  return amount * multiplier;
}

/**
 * Returns true only for requests that ask the bot to enumerate a sequence
 * whose requested endpoint is 10,000 or greater. Normal questions involving
 * large numbers are intentionally ignored.
 */
export function isExcessiveEnumerationRequest(prompt: string): boolean {
  const text = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return false;

  const enumerationIntent = /\b(?:count|counting|enumerate|enumerating|list|write|print|output|generate)\b/.test(text);
  if (!enumerationIntent) return false;

  // count to 10000 / count up to 10k / list every number to 1,000,000
  const endpointPatterns = [
    /\b(?:count|enumerate|list|write|print|output|generate)(?:\s+\w+){0,5}\s+(?:to|through|until|up\s+to)\s+([\d,_]+(?:\.\d+)?\s*(?:k|m|b|t|million|billion|trillion)?)/i,
    /\b(?:count|enumerate|list|write|print|output|generate)(?:\s+\w+){0,8}\s+from\s+[^\d\n]*\d[\d,_]*\s+(?:to|through|until)\s+([\d,_]+(?:\.\d+)?\s*(?:k|m|b|t|million|billion|trillion)?)/i,
    /\b(?:every|all)\s+(?:number|integer)s?\s+(?:from|between)\b[^\n]*?\b(?:to|and)\s+([\d,_]+(?:\.\d+)?\s*(?:k|m|b|t|million|billion|trillion)?)/i,
  ];

  for (const pattern of endpointPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const endpoint = parseCount(match[1].replace(/\s+/g, ''));
      if (endpoint !== null && endpoint >= MAX_ENUMERATION_COUNT + 1) return true;
    }
  }

  // Explicit huge-number language is unambiguously an excessive enumeration.
  if (/\b(?:count|enumerate|list|write|print|output|generate)\b[\s\S]{0,80}\b(?:ten\s+thousand|hundred\s+thousand|million|billion|trillion)\b/i.test(text)) {
    return true;
  }

  return false;
}

export const EXCESSIVE_ENUMERATION_MESSAGE =
  '🛑 That enumeration is too large. I can count or list up to **9,999** items, but not 10,000 or more.';
