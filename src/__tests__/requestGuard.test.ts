import { describe, expect, it } from 'vitest';
import { isExcessiveEnumerationRequest } from '../utils/requestGuard.js';

describe('isExcessiveEnumerationRequest', () => {
  it('allows counts below 10000', () => {
    expect(isExcessiveEnumerationRequest('count to 9999')).toBe(false);
    expect(isExcessiveEnumerationRequest('count from 1 to 5000')).toBe(false);
  });

  it('blocks 10000 and above', () => {
    expect(isExcessiveEnumerationRequest('count to 10000')).toBe(true);
    expect(isExcessiveEnumerationRequest('count to 10,000')).toBe(true);
    expect(isExcessiveEnumerationRequest('count to 10k')).toBe(true);
    expect(isExcessiveEnumerationRequest('count from 1 to 1,000,000')).toBe(true);
    expect(isExcessiveEnumerationRequest('list every number from 1 to 1 billion')).toBe(true);
  });

  it('does not block normal questions about large numbers', () => {
    expect(isExcessiveEnumerationRequest('what is 10,000 divided by 2?')).toBe(false);
    expect(isExcessiveEnumerationRequest('what is a billion?')).toBe(false);
  });
});
