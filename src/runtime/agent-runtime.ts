import type { AgentEvent } from '../core/events.js';
import { AllowAllPolicy, type Policy } from '../core/policy.js';
import type { EventSink } from '../observability/sinks.js';
import type { EventStore } from '../persistence/stores.js';
import { createRunState, type RunState } from '../core/state.js';
import { ConfigurationError, SessionNotFoundError } from '../core/errors.js';
import type { RunStore } from '../persistence/stores.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ToolRegistry } from '../tools/registry.js';
import { AgentLoop, collectAgentResult, type AgentRunRequest } from './agent-loop.js';
import { ModelRuntime } from './model-runtime.js';
import { AgentSessionsRuntime } from './agent-sessions.js';
import type { SessionStore } from '../persistence/stores.js';
import { PromptRuntime } from '../planning/index.js';
import { ProviderCacheRuntime } from '../cache/index.js';
import type { ProviderCacheStore } from '../persistence/stores.js';
import { RealtimeRuntime } from './realtime-runtime.js';

export type AgentRuntimeRequest<T = string> = Omit<AgentRunRequest<T>, 'model' | 'trace_id'> & {
  readonly model?: string;
  readonly trace_id?: string;
};

export interface AgentRuntimeOptions {
  readonly registry?: ProviderRegistry;
  readonly tools?: ToolRegistry;
  readonly policy?: Policy;
  readonly event_store?: EventStore;
  readonly event_sink?: EventSink;
  readonly run_store?: RunStore;
  readonly session_store?: SessionStore;
  readonly provider_cache_store?: ProviderCacheStore;
}

export class AgentRuntime {
  readonly registry: ProviderRegistry;
  readonly tools: ToolRegistry;
  readonly models: ModelRuntime;
  readonly loop: AgentLoop;
  readonly agents: AgentSessionsRuntime;
  readonly prompts: PromptRuntime;
  readonly cache: ProviderCacheRuntime;
  readonly realtime: RealtimeRuntime;
  private readonly eventStore?: EventStore;
  private readonly eventSink?: EventSink;
  private readonly runStore?: RunStore;

  constructor(options: AgentRuntimeOptions = {}) {
    this.registry = options.registry ?? new ProviderRegistry();
    this.tools = options.tools ?? new ToolRegistry();
    this.models = new ModelRuntime(this.registry);
    this.loop = new AgentLoop(this.models, this.tools, options.policy ?? new AllowAllPolicy());
    this.agents = new AgentSessionsRuntime(this.registry, options.session_store);
    this.prompts = new PromptRuntime();
    this.cache = new ProviderCacheRuntime(options.provider_cache_store);
    this.realtime = new RealtimeRuntime(this.registry);
    this.eventStore = options.event_store;
    this.eventSink = options.event_sink;
    this.runStore = options.run_store;
  }

  async *stream<T = string>(request: AgentRuntimeRequest<T>): AsyncIterable<AgentEvent> {
    yield* this.streamResolved(this.resolveRequest(request));
  }

  private async *streamResolved<T = string>(
    request: AgentRunRequest<T>,
  ): AsyncIterable<AgentEvent> {
    for await (const event of this.loop.stream(request)) {
      await this.eventStore?.append(event);
      await this.eventSink?.emit(event);
      yield event;
    }
  }

  async run<T = string>(request: AgentRuntimeRequest<T>) {
    const resolved = this.resolveRequest(request);
    const result = await collectAgentResult<T>(this.streamResolved(resolved));
    if (resolved.session_id !== undefined) {
      await this.runStore?.save(
        createRunState({
          session_id: resolved.session_id,
          provider: result.provider_state?.provider,
          model: resolved.model,
          provider_state: result.provider_state,
          items: result.items,
          metadata: result.metadata,
        }),
      );
    }
    return result;
  }

  async resume<T = string>(
    sessionId: string,
    request: Omit<AgentRuntimeRequest<T>, 'session_id' | 'provider_state'>,
  ) {
    const state = await this.runStore?.load(sessionId);
    if (state === undefined) {
      throw new SessionNotFoundError(`No persisted run state exists for session '${sessionId}'.`, {
        session_id: sessionId,
        operation: 'runtime.resume',
      });
    }
    return this.run({ ...request, session_id: sessionId, provider_state: state.provider_state });
  }

  loadRunState(sessionId: string): RunState | undefined | Promise<RunState | undefined> {
    return this.runStore?.load(sessionId);
  }

  close(): Promise<void> {
    return this.registry.close();
  }

  private resolveRequest<T>(request: AgentRuntimeRequest<T>): AgentRunRequest<T> {
    if (request.config !== undefined) return request.config.resolveRun(request, 'runtime');
    if (request.model === undefined) {
      throw new ConfigurationError('Agent runtime requires a model or configured provider.', {
        code: 'model_required',
      });
    }
    return {
      ...request,
      model: request.model,
      trace_id: request.trace_id ?? crypto.randomUUID(),
    };
  }
}
