import { ApprovalManager } from '../core/approvals.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { WorkspaceError } from '../core/errors.js';
import { allow, AllowAllPolicy, type Policy } from '../core/policy.js';
import type { EventSink } from '../observability/sinks.js';
import type { EventStore } from '../persistence/stores.js';
import { LocalWorkspaceProvider } from './local.js';
import { WorkspaceRegistry } from './registry.js';
import type { Workspace, WorkspaceOpenSpec } from './types.js';

export interface WorkspaceRuntimeOptions {
  readonly policy?: Policy;
  readonly approvals?: ApprovalManager;
  readonly event_store?: EventStore;
  readonly event_sink?: EventSink;
  readonly register_local?: boolean;
}

export class WorkspaceRuntime {
  readonly approvals: ApprovalManager;
  private readonly active = new Map<string, Workspace>();
  private readonly policy: Policy;

  constructor(
    readonly registry = new WorkspaceRegistry(),
    private readonly options: WorkspaceRuntimeOptions = {},
  ) {
    this.policy = options.policy ?? new AllowAllPolicy();
    this.approvals = options.approvals ?? new ApprovalManager();
    if (options.register_local !== false && !registry.has('local')) {
      registry.register(
        new LocalWorkspaceProvider({
          policy: this.policy,
          approval_manager: this.approvals,
          emit: (event) => this.record(event),
        }),
      );
    }
  }

  async open(spec: WorkspaceOpenSpec): Promise<Workspace> {
    const decision =
      (await this.policy.check({
        checkpoint: 'before_workspace_open',
        action: `workspace.open:${spec.kind}`,
        arguments: { kind: spec.kind, ref: spec.ref, readonly: spec.readonly },
        metadata: spec.metadata ?? {},
      })) ?? allow();
    if (decision.verdict === 'deny') {
      throw new WorkspaceError(decision.reason ?? 'Workspace open was denied by policy.', {
        code: 'policy_denied',
      });
    }
    if (decision.verdict === 'require_approval') {
      const ticket = this.approvals.request(`workspace.open:${spec.kind}`, {
        reason: decision.reason,
        data: { spec, checkpoint: 'before_workspace_open' },
      });
      await this.record(
        createAgentEvent({
          type: AgentEventTypes.APPROVAL_REQUESTED,
          data: { request: ticket.request },
        }),
      );
      const approval = await ticket.decision;
      await this.record(
        createAgentEvent({
          type: approval.approved
            ? AgentEventTypes.APPROVAL_APPROVED
            : AgentEventTypes.APPROVAL_DENIED,
          data: { approval_id: ticket.request.id, decision: approval },
        }),
      );
      if (!approval.approved) {
        throw new WorkspaceError(approval.reason ?? 'Workspace open approval was denied.', {
          code: 'approval_denied',
        });
      }
    }
    const workspace = await this.registry.open(spec);
    this.active.set(workspace.id, workspace);
    return workspace;
  }

  get(id: string): Workspace {
    const workspace = this.active.get(id);
    if (workspace === undefined) {
      throw new WorkspaceError(`Workspace '${id}' is not active.`, {
        code: 'workspace_not_found',
      });
    }
    return workspace;
  }

  list(): readonly Workspace[] {
    return [...this.active.values()];
  }

  async close(workspace?: string | Workspace): Promise<void> {
    if (workspace !== undefined) {
      const value = typeof workspace === 'string' ? this.get(workspace) : workspace;
      this.active.delete(value.id);
      await value.close();
      return;
    }
    await Promise.all([...this.active.values()].map(async (value) => value.close()));
    this.active.clear();
    await this.registry.close();
  }

  private async record(event: AgentEvent): Promise<void> {
    await this.options.event_store?.append(event);
    await this.options.event_sink?.emit(event);
  }
}
