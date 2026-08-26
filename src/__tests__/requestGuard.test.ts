import { describe, expect, it } from 'vitest';
import { applyAIEnumerationClassification, clearEnumerationState, getEnumerationMaxRequested, isExcessiveEnumerationRequest } from '../utils/requestGuard.js';

describe('enumeration guard', () => {
  it('allows below and exactly 1000', () => {
    expect(isExcessiveEnumerationRequest('count to 999', 't1')).toBe(false);
    expect(isExcessiveEnumerationRequest('count to 1000', 't2')).toBe(false);
  });

  it('blocks above 1000', () => {
    expect(isExcessiveEnumerationRequest('count to 1001', 't3')).toBe(true);
    expect(isExcessiveEnumerationRequest('count to 10k', 't4')).toBe(true);
  });

  it('AI fresh requests replace the previous total', () => {
    const scope = 'fresh';
    clearEnumerationState(scope);
    expect(applyAIEnumerationClassification(scope, 400, false)).toBe(false);
    expect(applyAIEnumerationClassification(scope, 10, false)).toBe(false);
    expect(getEnumerationMaxRequested(scope)).toBe(10);
  });

  it('AI continuations accumulate against the 1000 limit', () => {
    const scope = 'continuation';
    clearEnumerationState(scope);
    expect(applyAIEnumerationClassification(scope, 400, false)).toBe(false);
    expect(applyAIEnumerationClassification(scope, 500, true)).toBe(false);
    expect(getEnumerationMaxRequested(scope)).toBe(900);
    expect(applyAIEnumerationClassification(scope, 100, true)).toBe(false);
    expect(getEnumerationMaxRequested(scope)).toBe(1000);
    expect(applyAIEnumerationClassification(scope, 1, true)).toBe(true);
  });
});
