const MAX_ENUMERATION_COUNT = 1_000;
const ENUMERATION_WINDOW_MS = 24 * 60 * 60 * 1000;

type EnumerationState = { startedAt: number; maxRequested: number; coveredItems: number };
const enumerationState = new Map<string, EnumerationState>();

const SMALL_NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function parseNumberWords(value: string): number | null {
  const words = value.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 10) return null;
  let total = 0, current = 0; let sawNumber = false;
  for (const word of words) {
    if (word === 'and') continue;
    if (SMALL_NUMBER_WORDS[word] !== undefined) { current += SMALL_NUMBER_WORDS[word]; sawNumber = true; }
    else if (word === 'hundred') { current = Math.max(1, current) * 100; sawNumber = true; }
    else if (word === 'thousand') { total += Math.max(1, current) * 1_000; current = 0; sawNumber = true; }
    else if (word === 'million') { total += Math.max(1, current) * 1_000_000; current = 0; sawNumber = true; }
    else if (word === 'billion') { total += Math.max(1, current) * 1_000_000_000; current = 0; sawNumber = true; }
    else if (word === 'trillion') { total += Math.max(1, current) * 1_000_000_000_000; current = 0; sawNumber = true; }
    else return null;
  }
  return sawNumber ? total + current : null;
}

function parseCount(value: string): number | null {
  const normalized = value.toLowerCase().replace(/,/g, '').replace(/_/g, '').trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)(k|m|million|b|billion|t|trillion)?$/);
  if (!match) return parseNumberWords(normalized);
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const multiplier = { k: 1_000, m: 1_000_000, million: 1_000_000, b: 1_000_000_000, billion: 1_000_000_000, t: 1_000_000_000_000, trillion: 1_000_000_000_000 }[match[2] ?? ''] ?? 1;
  return amount * multiplier;
}

type EnumerationRange = { start: number; end: number; count: number };

function extractEnumerationRange(prompt: string, previous?: EnumerationState): EnumerationRange | null {
  const text = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  const enumerationVerb = /\b(?:count|counting|enumerate|enumerating|list|write|print|output|generate)\b/;

  if (!enumerationVerb.test(text)) {
    if (!previous) return null;

    // Once enumeration mode is active, continuation wording is deliberately
    // conservative. This catches both digits and English words, including
    // "add two hundred more" and "add two hundred".
    if (previous.maxRequested >= MAX_ENUMERATION_COUNT && /\b(?:more|another|continue|add)\b/i.test(text)) {
      return { start: previous.maxRequested + 1, end: MAX_ENUMERATION_COUNT + 1, count: 2 };
    }

    const withMore = text.match(/\b(?:add|do|give|continue|print|output|write|list|count)\s+(?:another\s+)?([\w ,_-]+?)\s+more\b/i)
      ?? text.match(/\banother\s+([\w ,_-]+?)(?:\s+(?:numbers?|items?|values?))?\s*$/i)
      ?? text.match(/\b([\w ,_-]+?)\s+more\b/i);
    if (withMore?.[1]) {
      const count = parseCount(withMore[1]);
      if (count !== null && count > 0) {
        const start = previous.maxRequested + 1;
        return { start, end: start + count - 1, count };
      }
    }

    // Also catch "add two hundred" / "add 200" without the word "more".
    const addOnly = text.match(/^add\s+(?:another\s+)?([\w ,_-]+?)(?:\s+(?:numbers?|items?|values?))?\s*[.!?]?$/i);
    if (addOnly?.[1]) {
      const count = parseCount(addOnly[1]);
      if (count !== null && count > 0) {
        const start = previous.maxRequested + 1;
        return { start, end: start + count - 1, count };
      }
    }

    const bareMore = text.match(/^([\w -]+)\s+more$/i);
    if (bareMore) {
      const count = parseCount(bareMore[1]);
      if (count !== null && count > 0) {
        const start = previous.maxRequested + 1;
        return { start, end: start + count - 1, count };
      }
    }
    return null;
  }

  const direct = text.match(/\b(?:count|enumerate|list|write|print|output|generate)(?:\s+\w+){0,5}\s+(?:to|through|until|up\s+to)\s+([\w,_ -]+?)(?=\s*(?:[.!?]|$))/i);
  if (direct?.[1]) { const end = parseCount(direct[1]); if (end !== null) return { start: 1, end, count: Math.max(0, end) }; }

  const range = text.match(/\b(?:count|enumerate|list|write|print|output|generate)(?:\s+\w+){0,8}\s+from\s+([\w,_ -]+?)\s+(?:to|through|until)\s+([\w,_ -]+?)(?=\s*(?:[.!?]|$))/i);
  if (range?.[1] && range[2]) { const start = parseCount(range[1]); const end = parseCount(range[2]); if (start !== null && end !== null) return { start, end, count: Math.max(0, end - start + 1) }; }

  const every = text.match(/\b(?:every|all)\s+(?:number|integer)s?\s+(?:from|between)\s+([\w,_ -]+?)\s+(?:to|and)\s+([\w,_ -]+?)(?=\s*(?:[.!?]|$))/i);
  if (every?.[1] && every[2]) { const start = parseCount(every[1]); const end = parseCount(every[2]); if (start !== null && end !== null) return { start, end, count: Math.max(0, end - start + 1) }; }

  if (/\b(?:count|enumerate|list|write|print|output|generate)\b[\s\S]{0,80}\b(?:ten\s+thousand|hundred\s+thousand|million|billion|trillion)\b/i.test(text)) return { start: 1, end: MAX_ENUMERATION_COUNT + 1, count: MAX_ENUMERATION_COUNT + 1 };
  return null;
}

export function isExcessiveEnumerationRequest(prompt: string, scopeKey = 'global'): boolean {
  const now = Date.now();
  const previous = enumerationState.get(scopeKey);
  const activePrevious = previous && now - previous.startedAt <= ENUMERATION_WINDOW_MS ? previous : undefined;
  const range = extractEnumerationRange(prompt, activePrevious);
  if (!range) return false;
  if (range.count > MAX_ENUMERATION_COUNT || range.end > MAX_ENUMERATION_COUNT) return true;
  if (!activePrevious) {
    enumerationState.set(scopeKey, { startedAt: now, maxRequested: range.end, coveredItems: range.count });
    return false;
  }
  const isContinuation = range.start <= activePrevious.maxRequested + 1 && range.end >= activePrevious.maxRequested;
  const mergedCoverage = isContinuation ? Math.max(activePrevious.maxRequested, range.end) - Math.min(1, range.start) + 1 : activePrevious.coveredItems + range.count;
  if (mergedCoverage > MAX_ENUMERATION_COUNT) return true;
  enumerationState.set(scopeKey, { startedAt: activePrevious.startedAt, maxRequested: Math.max(activePrevious.maxRequested, range.end), coveredItems: mergedCoverage });
  return false;
}

export function clearEnumerationState(scopeKey: string): void { enumerationState.delete(scopeKey); }

export const EXCESSIVE_ENUMERATION_MESSAGE = '🛑 That enumeration is too large. I can count or list up to **1,000 items total**, including segmented requests.';
