import { describe, expect, it } from 'vitest';

import { AgentEventTypes } from '../../src/index.js';
import { codexEventType, coerceCodexEvent } from '../../src/providers/codex-app-server.js';

describe('codex app-server event mapping', () => {
  it('maps reviewed events and preserves raw payloads', () => {
    const raw = {
      id: 'evt_delta',
      method: 'item/agentMessage/delta',
      params: { delta: 'hello', itemId: 'item_1', threadId: 'thread_1', turnId: 'turn_1' },
    };

    const event = coerceCodexEvent(raw, { provider: 'codex', session_id: 'thread_1' });

    expect(event.type).toBe(AgentEventTypes.MODEL_TEXT_DELTA);
    expect(event.id).toBe('evt_delta');
    expect(event.item_id).toBe('item_1');
    expect(event.data).toEqual({
      method: 'item/agentMessage/delta',
      delta: 'hello',
      itemId: 'item_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
    });
    expect(event.raw).toBe(raw);
    expect(event).toMatchObject({ provider: 'codex', session_id: 'thread_1' });
  });

  it('unknown notification is a non-authority log projection', () => {
    const raw = {
      id: 'evt_future',
      method: 'item/futureProgress',
      params: { threadId: 'thread_1', turnId: 'turn_1' },
    };

    const event = coerceCodexEvent(raw, { provider: 'codex', session_id: 'thread_1' });

    expect(event.type).toBe(AgentEventTypes.CLOUD_AGENT_LOG);
    expect(event.raw).toBe(raw);
  });

  it('pins the full method table of the parent adapter', () => {
    const item = (type: string) => ({ item: { id: 'item_x', type } });
    const turn = (status?: string) => ({ turn: { id: 'turn_1', status } });
    const table: readonly [string, Record<string, unknown>, string][] = [
      ['blackbox/session/started', {}, AgentEventTypes.SESSION_STARTED],
      ['blackbox/session/cancelled', {}, AgentEventTypes.SESSION_CANCELLED],
      ['blackbox/session/failed', {}, AgentEventTypes.SESSION_FAILED],
      ['blackbox/approval/requested', {}, AgentEventTypes.APPROVAL_REQUESTED],
      ['turn/started', turn(), AgentEventTypes.MODEL_REQUEST_STARTED],
      ['turn/completed', turn('interrupted'), AgentEventTypes.SESSION_CANCELLED],
      ['turn/completed', turn('failed'), AgentEventTypes.SESSION_FAILED],
      ['turn/completed', turn('completed'), AgentEventTypes.SESSION_COMPLETED],
      ['turn/completed', {}, AgentEventTypes.SESSION_COMPLETED],
      ['item/agentMessage/delta', {}, AgentEventTypes.MODEL_TEXT_DELTA],
      ['item/reasoning/textDelta', {}, AgentEventTypes.MODEL_REASONING_DELTA],
      ['item/reasoning/summaryTextDelta', {}, AgentEventTypes.MODEL_REASONING_DELTA],
      ['item/commandExecution/outputDelta', {}, AgentEventTypes.WORKSPACE_COMMAND_OUTPUT],
      ['item/fileChange/outputDelta', {}, AgentEventTypes.WORKSPACE_FILE_CHANGED],
      ['item/fileChange/patchUpdated', {}, AgentEventTypes.WORKSPACE_FILE_CHANGED],
      ['turn/diff/updated', {}, AgentEventTypes.WORKSPACE_FILE_CHANGED],
      ['item/mcpToolCall/progress', {}, AgentEventTypes.MCP_CALL_STARTED],
      ['item/started', item('commandExecution'), AgentEventTypes.WORKSPACE_COMMAND_STARTED],
      ['item/started', item('mcpToolCall'), AgentEventTypes.MCP_CALL_STARTED],
      ['item/started', item('webSearch'), AgentEventTypes.HOSTED_TOOL_CALL_STARTED],
      ['item/started', item('dynamicToolCall'), AgentEventTypes.HOSTED_TOOL_CALL_STARTED],
      ['item/started', item('agentMessage'), AgentEventTypes.AGENT_RESPONSE_MESSAGE_CREATED],
      ['item/started', item('reasoning'), AgentEventTypes.MODEL_ITEM_CREATED],
      ['item/started', {}, AgentEventTypes.MODEL_ITEM_CREATED],
      ['item/completed', item('commandExecution'), AgentEventTypes.WORKSPACE_COMMAND_COMPLETED],
      ['item/completed', item('fileChange'), AgentEventTypes.WORKSPACE_FILE_CHANGED],
      ['item/completed', item('mcpToolCall'), AgentEventTypes.MCP_CALL_COMPLETED],
      ['item/completed', item('webSearch'), AgentEventTypes.HOSTED_TOOL_CALL_COMPLETED],
      ['item/completed', item('dynamicToolCall'), AgentEventTypes.HOSTED_TOOL_CALL_COMPLETED],
      ['item/completed', item('agentMessage'), AgentEventTypes.AGENT_RESPONSE_MESSAGE_CREATED],
      ['item/completed', item('reasoning'), AgentEventTypes.MODEL_ITEM_COMPLETED],
      ['thread/started', {}, AgentEventTypes.CLOUD_AGENT_LOG],
      ['', {}, AgentEventTypes.CLOUD_AGENT_LOG],
    ];

    for (const [method, params, expected] of table) {
      expect(codexEventType(method, params), `${method} ${JSON.stringify(params)}`).toBe(expected);
    }
    // Item ids come from the item itself when no top-level id is present.
    expect(
      coerceCodexEvent(
        { method: 'item/completed', params: item('fileChange') },
        { provider: 'codex', session_id: 'thread_1' },
      ),
    ).toMatchObject({ item_id: 'item_x', type: AgentEventTypes.WORKSPACE_FILE_CHANGED });
    // A payload without an id or params still normalizes to a log projection.
    expect(
      coerceCodexEvent('garbage', { provider: 'codex', session_id: 'thread_1' }),
    ).toMatchObject({
      type: AgentEventTypes.CLOUD_AGENT_LOG,
      data: { method: '' },
      raw: 'garbage',
    });
  });
});
