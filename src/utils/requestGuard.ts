const MAX_ENUMERATION_COUNT = 9_999;
const ENUMERATION_WINDOW_MS = 24 * 60 * 60 * 1000;

type EnumerationState = {
  startedAt: number;
  maxRequested: number;
  coveredItems: number;
};

const enumerationState = new Map<string, EnumerationState>();

function parseCount(value: string): number | null {
  const normalized = value.toLowerCase().replace(/,/g, '').replace(/_/g, '').trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)(k|m|million|b|billion|t|trillion)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const multiplier = {
    k: 1_000, m: 1_000_000, million: 1_000_000,
    b: 1_000_000_000, billion: 1_000_000_000,
    t: 1_000_000_000_000, trillion: 1_000_000_000_000,
  }[match[2] ?? ''] ?? 1;
  return amount * multiplier;
}

type EnumerationRange = { start: number; end: number; count: number };

function extractEnumerationRange(prompt: string): EnumerationRange | null {
  const text = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!/\b(?:count|counting|enumerate|enumerating|list|write|print|output|generate)\b/.test(text)) return null;

  const direct = text.match(/\b(?:count|enumerate|list|write|print|output|generate)(?:\s+\w+){0,5}\s+(?:to|through|until|up\s+to)\s+([\d,_]+(?:\.\d+)?\s*(?:k|m|b|t|million|billion|trillion)?)/i);
  if (direct?.[1]) {
    const end = parseCount(direct[1]);
    if (end !== null) return { start: 1, end, count: Math.max(0, end) };
  }

  const range = text.match(/\b(?:count|enumerate|list|write|print|output|generate)(?:\s+\w+){0,8}\s+from\s+([\d,_]+(?:\.\d+)?\s*(?:k|m|b|t|million|billion|trillion)?)\s+(?:to|through|until)\s+([\d,_]+(?:\.\d+)?\s*(?:k|m|b|t|million|billion|trillion)?)/i);
  if (range?.[1] && range[2]) {
    const start = parseCount(range[1]);
    const end = parseCount(range[2]);
    if (start !== null && end !== null) return { start, end, count: Math.max(0, end - start + 1) };
  }

  const every = text.match(/\b(?:every|all)\s+(?:number|integer)s?\s+(?:from|between)\s+([\d,_]+(?:\.\d+)?\s*(?:k|m|b|t|million|billion|trillion)?)\s+(?:to|and)\s+([\d,_]+(?:\.\d+)?\s*(?:k|m|b|t|million|billion|trillion)?)/i);
  if (every?.[1] && every[2]) {
    const start = parseCount(every[1]);
    const end = parseCount(every[2]);
    if (start !== null && end !== null) return { start, end, count: Math.max(0, end - start + 1) };
  }

  // Explicit large enumeration language without a numeric endpoint.
  if (/\b(?:count|enumerate|list|write|print|output|generate)\b[\s\S]{0,80}\b(?:ten\s+thousand|hundred\s+thousand|million|billion|trillion)\b/i.test(text)) {
    return { start: 1, end: MAX_ENUMERATION_COUNT + 1, count: MAX_ENUMERATION_COUNT + 1 };
  }
  return null;
}

/**
 * Checks a prompt against the 9,999 enumeration ceiling and remembers
 * enumeration ranges per user/conversation. This prevents bypasses such as
 * asking for 1-5,000 and then 5,001-10,000 in separate messages.
 */
export function isExcessiveEnumerationRequest(prompt: string, scopeKey = 'global'): boolean {
  const range = extractEnumerationRange(prompt);
  if (!range) return false;

  if (range.count > MAX_ENUMERATION_COUNT || range.end > MAX_ENUMERATION_COUNT) return true;

  const now = Date.now();
  const previous = enumerationState.get(scopeKey);
  if (!previous || now - previous.startedAt > ENUMERATION_WINDOW_MS) {
    enumerationState.set(scopeKey, {
      startedAt: now,
      maxRequested: range.end,
      coveredItems: range.count,
    });
    return false;
  }

  // Reject a new segment if the requested ranges extend the same enumeration
  // past the ceiling. Also reject contiguous continuation of the same sequence
  // once its cumulative coverage reaches the limit.
  const isContinuation = range.start <= previous.maxRequested + 1 && range.end >= previous.maxRequested;
  const mergedCoverage = isContinuation
    ? Math.max(previous.maxRequested, range.end) - Math.min(1, range.start) + 1
    : previous.coveredItems + range.count;

  if (mergedCoverage > MAX_ENUMERATION_COUNT) return true;

  enumerationState.set(scopeKey, {
    startedAt: previous.startedAt,
    maxRequested: Math.max(previous.maxRequested, range.end),
    coveredItems: mergedCoverage,
  });
  return false;
}

export function clearEnumerationState(scopeKey: string): void {
  enumerationState.delete(scopeKey);
}

export const EXCESSIVE_ENUMERATION_MESSAGE =
  '🛑 That enumeration is too large. I can count or list up to **9,999 items total**, including segmented requests.';
