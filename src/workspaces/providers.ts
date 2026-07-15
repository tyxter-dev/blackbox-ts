import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, resolve } from 'node:path';
import { WorkspaceError } from '../core/errors.js';
import { LocalWorkspaceProvider, type LocalWorkspaceOptions } from './local.js';
import type {
  DockerWorkspaceClient,
  SandboxWorkspaceClient,
  Workspace,
  WorkspaceKind,
  WorkspaceOpenSpec,
  WorkspaceProvider,
} from './types.js';

const execFileAsync = promisify(execFile);

export class GitWorkspaceProvider implements WorkspaceProvider {
  readonly id = 'git';
  readonly kind = 'git' as const;

  constructor(
    private readonly checkoutRoot: string,
    private readonly options: LocalWorkspaceOptions = {},
  ) {}

  async open(spec: WorkspaceOpenSpec): Promise<Workspace> {
    assertKind(spec, 'git', this.id);
    const name = safeCheckoutName(spec.metadata?.name, spec.ref);
    const target = resolve(this.checkoutRoot, name);
    await mkdir(this.checkoutRoot, { recursive: true });
    try {
      await execFileAsync('git', ['clone', '--', spec.ref, target], {
        windowsHide: true,
        timeout: readNumber(spec.metadata?.timeout_ms) ?? 120_000,
      });
    } catch (cause) {
      throw new WorkspaceError('Git workspace clone failed.', {
        code: 'workspace_git_clone_failed',
        cause,
      });
    }
    const checkoutRef = readString(spec.metadata?.branch) ?? readString(spec.metadata?.ref);
    if (checkoutRef !== undefined) {
      try {
        await execFileAsync('git', ['-C', target, 'checkout', checkoutRef], {
          windowsHide: true,
          timeout: readNumber(spec.metadata?.timeout_ms) ?? 120_000,
        });
      } catch (cause) {
        throw new WorkspaceError(`Git workspace ref '${checkoutRef}' could not be checked out.`, {
          code: 'workspace_git_checkout_failed',
          cause,
        });
      }
    }
    return new LocalWorkspaceProvider(this.options).open({
      kind: 'git',
      ref: target,
      readonly: spec.readonly,
      metadata: spec.metadata,
    });
  }
}

export class SandboxWorkspaceProvider implements WorkspaceProvider {
  readonly id = 'sandbox';
  readonly kind = 'sandbox' as const;
  constructor(private readonly client: SandboxWorkspaceClient) {}
  open(spec: WorkspaceOpenSpec): Workspace | Promise<Workspace> {
    assertKind(spec, 'sandbox', this.id);
    return this.client.open(spec);
  }
}

export class DockerWorkspaceProvider implements WorkspaceProvider {
  readonly id = 'docker';
  readonly kind = 'docker' as const;
  constructor(private readonly client: DockerWorkspaceClient) {}
  open(spec: WorkspaceOpenSpec): Workspace | Promise<Workspace> {
    assertKind(spec, 'docker', this.id);
    return this.client.open(spec);
  }
}

export class CloudWorkspaceProvider implements WorkspaceProvider {
  readonly id: string;
  readonly kind = 'cloud' as const;
  constructor(
    id: string,
    private readonly client?: SandboxWorkspaceClient,
  ) {
    this.id = id;
  }
  open(spec: WorkspaceOpenSpec): Workspace | Promise<Workspace> {
    assertKind(spec, 'cloud', this.id);
    if (this.client !== undefined) return this.client.open(spec);
    return new OpaqueRemoteWorkspace(spec, this.id);
  }
}

export class ArtifactBundleWorkspaceProvider implements WorkspaceProvider {
  readonly id = 'artifact_bundle';
  readonly kind = 'artifact_bundle' as const;
  constructor(private readonly options: LocalWorkspaceOptions = {}) {}
  open(spec: WorkspaceOpenSpec): Promise<Workspace> {
    assertKind(spec, 'artifact_bundle', this.id);
    return new LocalWorkspaceProvider(this.options).open({
      ...spec,
      kind: 'artifact_bundle',
      readonly: true,
    });
  }
}

class OpaqueRemoteWorkspace implements Workspace {
  readonly id: string;
  readonly kind: WorkspaceKind = 'cloud';
  readonly readonly = true;
  constructor(spec: WorkspaceOpenSpec, provider: string) {
    this.id = `${provider}:${spec.ref}`;
  }
  read(): Promise<never> {
    return Promise.reject(unsupported());
  }
  write(): Promise<never> {
    return Promise.reject(unsupported());
  }
  delete(): Promise<never> {
    return Promise.reject(unsupported());
  }
  list(): Promise<never> {
    return Promise.reject(unsupported());
  }
  command(): Promise<never> {
    return Promise.reject(unsupported());
  }
  applyPatch(): Promise<never> {
    return Promise.reject(unsupported());
  }
  snapshot(): Promise<never> {
    return Promise.reject(unsupported());
  }
  restore(): Promise<never> {
    return Promise.reject(unsupported());
  }
  artifacts(): Promise<readonly never[]> {
    return Promise.resolve([]);
  }
  close(): void {}
}

function unsupported(): WorkspaceError {
  return new WorkspaceError('Opaque cloud workspaces require an injected provider client.', {
    code: 'workspace_operation_unsupported',
  });
}

function safeCheckoutName(value: unknown, ref: string): string {
  const candidate = typeof value === 'string' ? value : basename(ref).replace(/\.git$/i, '');
  if (!/^[a-z0-9._-]+$/i.test(candidate) || candidate.includes('..')) {
    throw new WorkspaceError(`Unsafe git checkout name '${candidate}'.`, {
      code: 'workspace_path_traversal',
    });
  }
  return candidate;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function assertKind(spec: WorkspaceOpenSpec, expected: WorkspaceKind, provider: string): void {
  if (spec.kind !== expected) {
    throw new WorkspaceError(
      `Workspace provider '${provider}' cannot open workspace kind '${spec.kind}'.`,
      { code: 'workspace_kind_mismatch' },
    );
  }
}
