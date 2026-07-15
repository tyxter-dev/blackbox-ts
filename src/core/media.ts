export type MediaSource = 'inline_base64' | 'bytes' | 'url' | 'artifact' | 'provider_file';
export type MediaSensitivity = 'public' | 'sensitive' | 'secret';

export interface MediaRef {
  readonly source: MediaSource;
  readonly mime_type: string;
  readonly data_base64?: string;
  readonly url?: string;
  readonly artifact_id?: string;
  readonly provider_file_id?: string;
  readonly bytes_count?: number;
  readonly storage_allowed: boolean;
  readonly sensitivity: MediaSensitivity;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface MediaRefOptions {
  readonly storage_allowed?: boolean;
  readonly sensitivity?: MediaSensitivity;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function mediaFromBytes(
  data: Uint8Array,
  mimeType: string,
  options: MediaRefOptions = {},
): MediaRef {
  return {
    source: 'inline_base64',
    mime_type: mimeType,
    data_base64: Buffer.from(data).toString('base64'),
    bytes_count: data.byteLength,
    storage_allowed: options.storage_allowed ?? false,
    sensitivity: options.sensitivity ?? 'sensitive',
    metadata: options.metadata ?? {},
  };
}

export function mediaFromBase64(
  dataBase64: string,
  mimeType: string,
  options: MediaRefOptions & { readonly bytes_count?: number } = {},
): MediaRef {
  return {
    source: 'inline_base64',
    mime_type: mimeType,
    data_base64: dataBase64,
    bytes_count: options.bytes_count ?? decodedBase64Size(dataBase64),
    storage_allowed: options.storage_allowed ?? false,
    sensitivity: options.sensitivity ?? 'sensitive',
    metadata: options.metadata ?? {},
  };
}

export function mediaFromUrl(
  url: string,
  mimeType: string,
  options: MediaRefOptions = {},
): MediaRef {
  return {
    source: 'url',
    mime_type: mimeType,
    url,
    storage_allowed: options.storage_allowed ?? true,
    sensitivity: options.sensitivity ?? 'public',
    metadata: options.metadata ?? {},
  };
}

export function mediaFromArtifact(
  artifactId: string,
  mimeType: string,
  options: MediaRefOptions = {},
): MediaRef {
  return {
    source: 'artifact',
    mime_type: mimeType,
    artifact_id: artifactId,
    storage_allowed: options.storage_allowed ?? true,
    sensitivity: options.sensitivity ?? 'sensitive',
    metadata: options.metadata ?? {},
  };
}

export function mediaFromProviderFile(
  providerFileId: string,
  mimeType: string,
  options: MediaRefOptions = {},
): MediaRef {
  return {
    source: 'provider_file',
    mime_type: mimeType,
    provider_file_id: providerFileId,
    storage_allowed: options.storage_allowed ?? true,
    sensitivity: options.sensitivity ?? 'sensitive',
    metadata: options.metadata ?? {},
  };
}

export function redactMedia(media: MediaRef): MediaRef {
  return {
    ...media,
    data_base64: undefined,
    metadata: { ...media.metadata, redacted: true },
  };
}

function decodedBase64Size(value: string): number | undefined {
  try {
    return Buffer.from(value, 'base64').byteLength;
  } catch {
    return undefined;
  }
}
