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
 * Uses the configured OpenAI API key as the intent/context classifier.
 * The classifier decides whether a request is a fresh enumeration or a
 * continuation. Deterministic code remains authoritative only for the final
 * 1,000-item safety limit.
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
    'Treat natural language as equivalent to numeric language: "two hundred" means 200, "one thousand" means 1000, "add two hundred", "another fifty", "200 more", and "keep counting" can be continuation requests.',
    'Use the wording and context to decide whether the request is a fresh task or a continuation. Do NOT assume every new "count to X" is a continuation merely because an earlier enumeration exists.',
    'After "count to 400", "count to 10" is a fresh request for 10 items, while "add another 500" is a continuation for 500 additional items.',
    'If the user explicitly asks to continue, add more, go on, keep counting, or otherwise extend the existing sequence, set isContinuation=true.',
    'For a fresh explicit endpoint such as "count to 500", requestedCount is 500 and isContinuation=false.',
    'For a continuation such as "add another 200", requestedCount is 200 and isContinuation=true.',
    'Do not judge whether the task is useful. Only classify the request.',
    'Return ONLY JSON with keys: isEnumeration (boolean), requestedCount (number|null), isContinuation (boolean), confidence (0..1).',
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
