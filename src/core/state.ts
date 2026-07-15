import type { RunItem } from './items.js';
import { createRuntimeId } from './ids.js';

export interface ProviderState {
  readonly provider: string;
  readonly model?: string;
  readonly conversation_id?: string;
  readonly previous_response_id?: string;
  readonly native_history: readonly unknown[];
  readonly reasoning_state: Readonly<Record<string, unknown>>;
  readonly tool_state: Readonly<Record<string, unknown>>;
  readonly continuation: Readonly<Record<string, unknown>>;
}

export type ProviderStateInput = Omit<
  ProviderState,
  'native_history' | 'reasoning_state' | 'tool_state' | 'continuation'
> & {
  readonly native_history?: readonly unknown[];
  readonly reasoning_state?: Readonly<Record<string, unknown>>;
  readonly tool_state?: Readonly<Record<string, unknown>>;
  readonly continuation?: Readonly<Record<string, unknown>>;
  /** @deprecated Use continuation for provider-specific continuation values. */
  readonly continuation_id?: string;
};

export function createProviderState(input: ProviderStateInput): ProviderState {
  return {
    provider: input.provider,
    model: input.model,
    conversation_id: input.conversation_id,
    previous_response_id: input.previous_response_id,
    native_history: input.native_history ?? [],
    reasoning_state: input.reasoning_state ?? {},
    tool_state: input.tool_state ?? {},
    continuation: {
      ...input.continuation,
      ...(input.continuation_id === undefined ? {} : { continuation_id: input.continuation_id }),
    },
  };
}

export interface RunState {
  readonly session_id: string;
  readonly provider?: string;
  readonly model?: string;
  readonly provider_state?: ProviderState;
  readonly items: readonly RunItem[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type RunStateInput = Omit<RunState, 'items' | 'metadata' | 'session_id'> & {
  readonly session_id?: string;
  readonly items?: readonly RunItem[];
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export function createRunState(input: RunStateInput = {}): RunState {
  return {
    ...input,
    session_id: input.session_id ?? createRuntimeId('sess'),
    items: input.items ?? [],
    metadata: input.metadata ?? {},
  };
}

export function addRunItem(state: RunState, item: RunItem): RunState {
  return { ...state, items: [...state.items, item] };
}
