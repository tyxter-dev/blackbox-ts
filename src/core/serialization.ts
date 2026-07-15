import { AgentRuntimeError } from './errors.js';
import { isRawEnvelope } from './raw.js';

export const DURABLE_FORMAT = 'blackbox-ts' as const;
export const DURABLE_FORMAT_VERSION = 1 as const;

export interface DurableEnvelope<T> {
  readonly format: typeof DURABLE_FORMAT;
  readonly format_version: typeof DURABLE_FORMAT_VERSION;
  readonly kind: string;
  readonly value: T;
}

export function serializeDurable<T>(kind: string, value: T): string {
  const envelope: DurableEnvelope<unknown> = {
    format: DURABLE_FORMAT,
    format_version: DURABLE_FORMAT_VERSION,
    kind,
    value: prepareForStorage(value),
  };
  return JSON.stringify(envelope);
}

export function deserializeDurable<T>(serialized: string, expectedKind?: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new AgentRuntimeError('Durable payload is not valid JSON.', {
      code: 'invalid_durable_payload',
      cause,
    });
  }

  if (!isDurableEnvelope(parsed)) {
    throw new AgentRuntimeError('Durable payload has an unsupported format or version.', {
      code: 'unsupported_durable_format',
    });
  }
  if (expectedKind !== undefined && parsed.kind !== expectedKind) {
    throw new AgentRuntimeError(
      `Durable payload kind '${parsed.kind}' does not match expected kind '${expectedKind}'.`,
      { code: 'durable_kind_mismatch' },
    );
  }
  return parsed.value as T;
}

function prepareForStorage(value: unknown): unknown {
  if (isRawEnvelope(value)) {
    if (value.storage_allowed) {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, prepareForStorage(child)]),
      );
    }
    return {
      ...value,
      payload: '<redacted:not-storage-allowed>',
      redaction_status: 'redacted',
    };
  }
  if (Array.isArray(value)) return value.map(prepareForStorage);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, prepareForStorage(child)]),
    );
  }
  return value;
}

function isDurableEnvelope(value: unknown): value is DurableEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'format' in value &&
    value.format === DURABLE_FORMAT &&
    'format_version' in value &&
    value.format_version === DURABLE_FORMAT_VERSION &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'value' in value
  );
}
