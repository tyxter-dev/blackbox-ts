export interface ProviderState {
  readonly provider: string;
  readonly model?: string;
  readonly previous_response_id?: string;
  readonly conversation_id?: string;
  readonly continuation_id?: string;
  readonly native_history?: unknown;
  readonly tool_state?: Readonly<Record<string, unknown>>;
  readonly reasoning_state?: Readonly<Record<string, unknown>>;
}
