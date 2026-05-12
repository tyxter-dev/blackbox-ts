import { describe, expect, it } from 'vitest';
import { InvalidProviderRefError, parseProviderModelRef, parseProviderRef } from '../../src/index.js';

describe('provider refs', () => {
  it('parses canonical provider:model references', () => {
    expect(parseProviderRef('openrouter:openai/gpt-4.1-mini')).toEqual({
      provider: 'openrouter',
      resource: 'openai/gpt-4.1-mini',
      raw: 'openrouter:openai/gpt-4.1-mini',
    });
    expect(parseProviderModelRef('openai:gpt-4.1-mini')).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
    });
  });

  it('supports fallback providers for legacy model-only input', () => {
    expect(parseProviderModelRef('claude-sonnet-4-5', 'anthropic')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
  });

  it('rejects empty or providerless refs without fallback', () => {
    expect(() => parseProviderModelRef('')).toThrow(InvalidProviderRefError);
    expect(() => parseProviderModelRef('gpt-4.1-mini')).toThrow(InvalidProviderRefError);
  });
});
