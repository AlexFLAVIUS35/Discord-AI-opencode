const DEFAULT_MODEL = process.env.ENUMERATION_GUARD_MODEL || 'gpt-5-mini';

export interface EnumerationClassification {
  isEnumeration: boolean;
  requestedCount: number | null;
  isContinuation: boolean;
  confidence: number;
}

function extractJson(text: string): EnumerationClassification | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const value = JSON.parse(match[0]);
    if (typeof value?.isEnumeration !== 'boolean') return null;
    return {
      isEnumeration: value.isEnumeration,
      requestedCount: typeof value.requestedCount === 'number' && Number.isFinite(value.requestedCount) ? value.requestedCount : null,
      isContinuation: Boolean(value.isContinuation),
      confidence: typeof value.confidence === 'number' ? Math.max(0, Math.min(1, value.confidence)) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Uses the configured OpenAI API key only as a language-understanding fallback.
 * The deterministic 1,000-item guard remains authoritative; this classifier
 * exists to catch natural-language variants such as "add two hundred" that
 * are difficult to enumerate safely with regexes alone.
 */
export async function classifyEnumerationRequest(
  prompt: string,
  previousMaxRequested: number,
): Promise<EnumerationClassification | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const system = [
    'You are a strict safety classifier for a Discord bot.',
    'Determine whether the user is asking the bot to enumerate, count, list, print, generate, or continue a repetitive sequence of numbered/items output.',
    'Treat natural language as equivalent to numeric language: "two hundred" means 200, "one thousand" means 1000, "add two hundred", "another fifty", "200 more", and "keep counting" are continuation requests when prior enumeration exists.',
    'Do not judge whether the task is useful. Only classify the request.',
    'Return ONLY JSON with keys: isEnumeration (boolean), requestedCount (number|null), isContinuation (boolean), confidence (0..1).',
    'requestedCount is the number of new items requested, not the final endpoint. For an explicit endpoint like "count to 900", use 900.',
  ].join(' ');

  const user = JSON.stringify({ prompt, previousMaxRequested });

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: user }] },
        ],
        max_output_tokens: 120,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;
    const data = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const outputText = data.output_text || data.output?.flatMap(item => item.content ?? []).map(item => item.text ?? '').join('') || '';
    return extractJson(outputText);
  } catch {
    return null;
  }
}
