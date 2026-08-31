const LEAK_PATTERNS: RegExp[] = [
  /\[strict output contract\]/i,
  /\[permanent personality instructions\]/i,
  /\[current user message\]/i,
  /\[system(?: prompt| message| instructions)?\]/i,
  /\[developer(?: message| instructions)?\]/i,
  /\b(?:system prompt|developer message|developer instructions|chain[- ]of[- ]thought)\b/i,
  /\b(?:internal reasoning|internal instructions|hidden instructions|private instructions)\b/i,
  /\b(?:my instructions|these instructions|the instructions say|the prompt says)\b/i,
  /\b(?:suggested next action|what I'd do next|the cleanest move|the open thread)\b/i,
  /\b(?:conversation[- ]management|tool\/session state)\b/i,
  /\bunless you \(creator\)\b/i,
];

const STRUCTURAL_MARKERS: RegExp[] = [
  /^(?:status|next step|suggested next action|current context|analysis|reasoning|plan|internal notes)\s*:/im,
  /^\s*[-*]\s*(?:status|next step|suggested next action|analysis|reasoning|plan)\s*:/im,
  /\b(?:user|assistant|developer|system)\s*(?:message|prompt|instructions)\s*:/i,
];

export interface SanitizedResponse {
  allowed: boolean;
  text: string;
  reason?: string;
}

/**
 * Model output is untrusted. This guard runs immediately before Discord output.
 * It deliberately blocks strong evidence of instruction/reasoning leakage instead
 * of trying to remove individual words, which would damage normal conversation.
 */
export function sanitizeModelOutput(input: string): SanitizedResponse {
  const text = input.trim();
  if (!text) return { allowed: true, text: '' };

  const leakHits = LEAK_PATTERNS.filter(pattern => pattern.test(text)).length;
  const structuralHits = STRUCTURAL_MARKERS.filter(pattern => pattern.test(text)).length;

  // A single unmistakable prompt marker is enough to block. Otherwise require
  // multiple independent indicators so ordinary uses of words like "system"
  // or "instructions" don't get suppressed.
  if (leakHits >= 2 || structuralHits >= 2 || (leakHits >= 1 && structuralHits >= 1)) {
    return { allowed: false, text: '', reason: `prompt/reasoning leak detected (${leakHits} leak markers, ${structuralHits} structural markers)` };
  }

  return { allowed: true, text };
}
