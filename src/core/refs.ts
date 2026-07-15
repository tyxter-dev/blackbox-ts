import { InvalidProviderRefError } from './errors.js';

export type AgentProviderId = string;
export type AgentModelId = string;

export interface ProviderRef {
  readonly provider: AgentProviderId;
  readonly resource: string;
  readonly raw: string;
}

export interface ProviderModelRef {
  readonly provider: AgentProviderId;
  readonly model: AgentModelId;
}

export function parseProviderRef(ref: string, fallbackProvider?: string): ProviderRef {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new InvalidProviderRefError(ref, 'Provider reference cannot be empty.');
  }

  const separator = trimmed.indexOf(':');
  if (separator > 0) {
    const provider = trimmed.slice(0, separator).trim();
    const resource = trimmed.slice(separator + 1).trim();
    if (!provider || !resource) {
      throw new InvalidProviderRefError(ref);
    }
    return { provider, resource, raw: trimmed };
  }

  if (fallbackProvider) {
    const provider = fallbackProvider.trim();
    if (!provider) {
      throw new InvalidProviderRefError(ref, 'Fallback provider cannot be empty.');
    }
    return { provider, resource: trimmed, raw: trimmed };
  }

  const legacySeparator = trimmed.indexOf('/');
  if (legacySeparator > 0 && legacySeparator < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, legacySeparator).trim(),
      resource: trimmed.slice(legacySeparator + 1).trim(),
      raw: trimmed,
    };
  }

  if (!fallbackProvider) {
    throw new InvalidProviderRefError(
      ref,
      `Provider reference '${ref}' is missing a provider. Use provider:model (or legacy provider/model) or pass a fallback provider.`,
    );
  }

  throw new InvalidProviderRefError(ref);
}

export function parseProviderModelRef(ref: string, fallbackProvider?: string): ProviderModelRef {
  const parsed = parseProviderRef(ref, fallbackProvider);
  return { provider: parsed.provider, model: parsed.resource };
}
