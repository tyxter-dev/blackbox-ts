import { describe, expect, it } from 'vitest';

import {
  AgentEventTypes,
  ApprovalManager,
  OutputValidationError,
  UnsupportedFeatureError,
  addRunItem,
  approve,
  artifactPage,
  contentToText,
  createAgentEvent,
  createAgentSession,
  createApprovalRequest,
  createArtifact,
  createProviderState,
  createRunItem,
  createRunState,
  deny,
  deserializeDurable,
  isRawEnvelope,
  mediaFromBytes,
  modelUsage,
  rawEnvelope,
  redactRawEnvelope,
  requireApproval,
  serializeDurable,
  sessionRef,
  transitionAgentSession,
} from '../../src/index.js';

describe('provider-neutral core contracts', () => {
  it('persists pending approvals and rejects duplicate or unknown decisions', async () => {
    const manager = new ApprovalManager();
    const ticket = manager.request('deploy', { id: 'approval_persisted' });
    const restored = new ApprovalManager(manager.snapshot());
    expect(restored.pending()).toHaveLength(1);
    const waiting = restored.wait(ticket.request.id);
    restored.decide(ticket.request.id, approve('reviewed'));
    await expect(waiting).resolves.toMatchObject({ approved: true });
    expect(() => restored.decide(ticket.request.id, deny('again'))).toThrowError(
      expect.objectContaining({ code: 'approval_already_decided' }),
    );
    expect(() => restored.decide('missing', deny())).toThrowError(
      expect.objectContaining({ code: 'approval_unknown' }),
    );
  });

  it('creates wire-compatible canonical events with stable correlation fields', () => {
    const event = createAgentEvent({
      type: AgentEventTypes.MODEL_TEXT_DELTA,
      run_id: 'run_1',
      sequence: 3,
      trace_id: 'trace_1',
      provider: 'echo',
      data: { delta: 'hello' },
    });

    expect(event.type).toBe('model.text.delta');
    expect(event.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(event.timestamp).toBe(new Date(event.timestamp).toISOString());
    expect(event).toMatchObject({ run_id: 'run_1', sequence: 3, trace_id: 'trace_1' });
  });

  it('preserves and explicitly redacts raw provider payloads', () => {
    const raw = rawEnvelope('openai', { response_id: 'resp_1' }, { sensitivity: 'secret' });
    const redacted = redactRawEnvelope(raw);

    expect(isRawEnvelope(raw)).toBe(true);
    expect(raw.payload).toEqual({ response_id: 'resp_1' });
    expect(redacted.payload).toBe('<redacted>');
    expect(redacted.redaction_status).toBe('redacted');
  });

  it('does not silently discard multimodal content during text projection', () => {
    const media = mediaFromBytes(new Uint8Array([1, 2, 3]), 'image/png');

    expect(() => contentToText([{ type: 'image', media }])).toThrow(UnsupportedFeatureError);
    expect(
      contentToText([
        { type: 'text', text: 'a' },
        { type: 'json', value: { b: 2 } },
      ]),
    ).toBe('a\n{"b":2}');
  });

  it('uses immutable run items and provider-native continuation state', () => {
    const providerState = createProviderState({
      provider: 'openai',
      previous_response_id: 'resp_1',
      continuation_id: 'legacy_1',
    });
    const state = createRunState({ provider_state: providerState });
    const item = createRunItem({ type: 'message', provider: 'openai' });
    const updated = addRunItem(state, item);

    expect(state.items).toHaveLength(0);
    expect(updated.items).toEqual([item]);
    expect(providerState.native_history).toEqual([]);
    expect(providerState.continuation).toEqual({ continuation_id: 'legacy_1' });
  });

  it('constructs session, artifact, and approval wire values', () => {
    const session = createAgentSession({ provider: 'local', task: 'ship parity' });
    const artifact = createArtifact({ type: 'report', name: 'parity.json', data: { ok: true } });
    const request = createApprovalRequest('workspace.write');

    expect(sessionRef(session)).toMatchObject({ provider: 'local', id: session.id });
    expect(artifactPage([artifact])).toEqual({ items: [artifact], has_more: false });
    expect(approve('safe').approved).toBe(true);
    expect(deny('unsafe').approved).toBe(false);
    expect(request.id).toMatch(/^approval_[0-9a-f]{32}$/);
    const running = transitionAgentSession(session, 'running');
    expect(transitionAgentSession(running, 'completed').status).toBe('completed');
    expect(() => transitionAgentSession({ ...running, status: 'completed' }, 'running')).toThrow(
      "cannot transition from 'completed'",
    );
  });

  it('retains raw output on validation failures', () => {
    const cause = new SyntaxError('bad json');
    const error = new OutputValidationError('invalid final output', '{', cause);

    expect(error.raw_text).toBe('{');
    expect(error.cause).toBe(cause);
    expect(error.code).toBe('output_validation_error');
  });

  it('round-trips versioned durable values and enforces raw storage policy', () => {
    const stored = serializeDurable('run_state', {
      kept: rawEnvelope('openai', { id: 'resp_1' }),
      secret: rawEnvelope('openai', { api_key: 'never-store' }, { storage_allowed: false }),
    });
    const parsed = deserializeDurable<{
      readonly kept: { readonly payload: unknown };
      readonly secret: { readonly payload: unknown; readonly redaction_status: string };
    }>(stored, 'run_state');

    expect(parsed.kept.payload).toEqual({ id: 'resp_1' });
    expect(parsed.secret).toMatchObject({
      payload: '<redacted:not-storage-allowed>',
      redaction_status: 'redacted',
    });
  });

  it('normalizes detailed usage and policy decisions', () => {
    const usage = modelUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      reasoning_tokens: 2,
      tool_calls: 1,
    });

    expect(usage).toMatchObject({
      total_tokens: 15,
      cached_input_tokens: 3,
      reasoning_tokens: 2,
      tool_calls: 1,
    });
    expect(requireApproval('sensitive')).toMatchObject({
      verdict: 'require_approval',
      reason: 'sensitive',
    });
  });

  it('snapshots the complete canonical event taxonomy', () => {
    expect(AgentEventTypes).toMatchSnapshot();
  });
});
