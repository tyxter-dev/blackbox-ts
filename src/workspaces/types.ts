import type { ArtifactRef } from '../core/artifacts.js';

export type WorkspaceKind =
  | 'local'
  | 'git'
  | 'sandbox'
  | 'docker'
  | 'cloud'
  | 'artifact_bundle'
  | 'remote';

export interface WorkspaceOpenSpec {
  readonly kind: WorkspaceKind;
  readonly ref: string;
  readonly readonly?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceFile {
  readonly path: string;
  readonly size: number;
  readonly modified_at: string;
  readonly directory: boolean;
}

export interface WorkspaceCommand {
  readonly program: string;
  readonly arguments?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
}

export interface WorkspaceCommandResult {
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
}

export type WorkspacePatchOperation =
  | { readonly operation: 'write'; readonly path: string; readonly content: string }
  | { readonly operation: 'delete'; readonly path: string };

export interface WorkspaceSnapshot {
  readonly id: string;
  readonly created_at: string;
  readonly files: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Workspace {
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly readonly: boolean;
  read(path: string): Promise<Uint8Array>;
  write(path: string, content: Uint8Array | string): Promise<void>;
  delete(path: string): Promise<void>;
  list(path?: string): Promise<readonly WorkspaceFile[]>;
  command(command: WorkspaceCommand): Promise<WorkspaceCommandResult>;
  applyPatch(operations: readonly WorkspacePatchOperation[]): Promise<void>;
  snapshot(metadata?: Readonly<Record<string, unknown>>): Promise<WorkspaceSnapshot>;
  restore(snapshot: WorkspaceSnapshot): Promise<void>;
  artifacts(): Promise<readonly ArtifactRef[]>;
  close(): void | Promise<void>;
}

export interface WorkspaceProvider {
  readonly id: string;
  readonly kind: WorkspaceKind;
  open(spec: WorkspaceOpenSpec): Workspace | Promise<Workspace>;
  close?(): void | Promise<void>;
}

export interface SandboxWorkspaceClient {
  open(spec: WorkspaceOpenSpec): Workspace | Promise<Workspace>;
}

export type DockerWorkspaceClient = SandboxWorkspaceClient;
