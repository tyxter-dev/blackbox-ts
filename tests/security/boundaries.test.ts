import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  MCPToolset,
  MCPTrustPresets,
  MemoryEventSink,
  RedactingEventSink,
  WorkerCredentials,
  createAgentEvent,
  rawEnvelope,
  unpackWorkspaceAgent,
} from '../../src/index.js';

describe('security boundaries', () => {
  it('keeps raw secrets and worker credentials out of exported representations', async () => {
    const memory = new MemoryEventSink();
    const sink = new RedactingEventSink(memory);
    const credentials = new WorkerCredentials('never-export-me');
    await sink.emit(
      createAgentEvent({
        type: 'run.completed',
        raw: rawEnvelope('provider', { token: 'never-export-me' }, { sensitivity: 'secret' }),
      }),
    );

    expect(JSON.stringify(memory.events)).not.toContain('never-export-me');
    expect(JSON.stringify(credentials)).not.toContain('never-export-me');
    expect(inspect(credentials)).not.toContain('never-export-me');
  });

  it('rejects untrusted remote MCP and archive traversal before use', async () => {
    const toolset = new MCPToolset(
      {
        name: 'remote',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        remote: true,
      },
      'provider_native',
      { trust: MCPTrustPresets.localOnly() },
    );
    await expect(toolset.resolve()).rejects.toMatchObject({ code: 'mcp_untrusted' });

    const invalidArchive = Buffer.alloc(30);
    invalidArchive.writeUInt32LE(0x04034b50, 0);
    expect(() => unpackWorkspaceAgent(invalidArchive)).toThrowError(
      expect.objectContaining({ code: 'malformed_agent_package' }),
    );
  });
});
