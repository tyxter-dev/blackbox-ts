import { createRuntimeId } from './ids.js';

export type ArtifactType =
  | 'file'
  | 'patch'
  | 'diff'
  | 'log'
  | 'report'
  | 'command_output'
  | 'workspace_snapshot'
  | 'deployment'
  | 'evaluation'
  | (string & Record<never, never>);

export interface ArtifactRef {
  readonly id: string;
  readonly provider?: string;
  readonly uri?: string;
}

export interface Artifact<T = unknown> {
  readonly type: ArtifactType;
  readonly name: string;
  readonly data?: T;
  readonly uri?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly id: string;
}

export interface FileArtifactData {
  readonly path?: string;
  readonly content?: string;
  readonly content_base64?: string;
  readonly mime_type?: string;
  readonly size_bytes?: number;
}

export interface PatchArtifactData {
  readonly patch: string;
  readonly paths: readonly string[];
  readonly base_revision?: string;
}

export interface CommandArtifactData {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number;
}

export interface ArtifactPage<T = unknown> {
  readonly items: readonly Artifact<T>[];
  readonly next_cursor?: string;
  readonly has_more: boolean;
}

export type ArtifactInput<T = unknown> = Omit<Artifact<T>, 'id' | 'metadata'> & {
  readonly id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export function createArtifact<T = unknown>(input: ArtifactInput<T>): Artifact<T> {
  return {
    ...input,
    metadata: input.metadata ?? {},
    id: input.id ?? createRuntimeId('art'),
  };
}

export function artifactRef<T>(artifact: Artifact<T>, provider?: string): ArtifactRef {
  return { id: artifact.id, provider, uri: artifact.uri };
}

export function artifactPage<T>(
  items: readonly Artifact<T>[],
  options: { readonly next_cursor?: string; readonly has_more?: boolean } = {},
): ArtifactPage<T> {
  return {
    items,
    next_cursor: options.next_cursor,
    has_more: options.has_more ?? false,
  };
}
