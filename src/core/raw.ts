export type RawSensitivity = 'public' | 'internal' | 'sensitive' | 'secret';
export type RawRedactionStatus = 'raw' | 'redacted' | 'hash_only';

export interface RawEnvelope<T = unknown> {
  readonly provider: string;
  readonly payload: T;
  readonly schema_name?: string;
  readonly schema_version?: string;
  readonly sensitivity: RawSensitivity;
  readonly redaction_status: RawRedactionStatus;
  readonly storage_allowed: boolean;
  readonly hash?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RawEnvelopeOptions {
  readonly schema_name?: string;
  readonly schema_version?: string;
  readonly sensitivity?: RawSensitivity;
  readonly redaction_status?: RawRedactionStatus;
  readonly storage_allowed?: boolean;
  readonly hash?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function rawEnvelope<T>(
  provider: string,
  payload: T,
  options: RawEnvelopeOptions = {},
): RawEnvelope<T> {
  return {
    provider,
    payload,
    schema_name: options.schema_name,
    schema_version: options.schema_version,
    sensitivity: options.sensitivity ?? 'internal',
    redaction_status: options.redaction_status ?? 'raw',
    storage_allowed: options.storage_allowed ?? true,
    hash: options.hash,
    metadata: options.metadata ?? {},
  };
}

export function redactRawEnvelope<T>(
  envelope: RawEnvelope<T>,
  marker = '<redacted>',
): RawEnvelope<string> {
  return {
    ...envelope,
    payload: marker,
    redaction_status: 'redacted',
    metadata: { ...envelope.metadata },
  };
}

export function isRawEnvelope(value: unknown): value is RawEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'provider' in value &&
    'payload' in value &&
    'redaction_status' in value &&
    'storage_allowed' in value
  );
}
