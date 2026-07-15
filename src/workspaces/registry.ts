import { ProviderNotRegisteredError } from '../core/errors.js';
import type { Workspace, WorkspaceOpenSpec, WorkspaceProvider } from './types.js';

export class WorkspaceRegistry {
  private readonly providers = new Map<string, WorkspaceProvider>();

  register(provider: WorkspaceProvider, aliases: readonly string[] = []): void {
    this.providers.set(provider.id, provider);
    this.providers.set(provider.kind, provider);
    for (const alias of aliases) this.providers.set(alias, provider);
  }

  get(id: string): WorkspaceProvider {
    const provider = this.providers.get(id);
    if (provider === undefined) {
      throw new ProviderNotRegisteredError(id, [...this.providers.keys()].sort());
    }
    return provider;
  }

  open(spec: WorkspaceOpenSpec): Workspace | Promise<Workspace> {
    return this.get(spec.kind).open(spec);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...new Set(this.providers.values())].map(async (provider) => provider.close?.()),
    );
  }
}

export class InjectedWorkspaceProvider implements WorkspaceProvider {
  constructor(
    readonly id: string,
    readonly kind: WorkspaceProvider['kind'],
    private readonly opener: WorkspaceProvider['open'],
  ) {}

  open(spec: WorkspaceOpenSpec): Workspace | Promise<Workspace> {
    return this.opener(spec);
  }
}
