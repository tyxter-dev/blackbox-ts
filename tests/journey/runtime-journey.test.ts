import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  LocalWorkspaceProvider,
  ProviderRegistry,
  ScriptedModelProvider,
  ToolRegistry,
  capability,
  createRunItem,
  textCompletionCapabilityProfile,
  workspaceToolDefinitions,
  type CapabilityProfile,
} from '../../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function toolProfile(model?: string): CapabilityProfile {
  const base = textCompletionCapabilityProfile('script', model);
  return {
    ...base,
    summary: { ...base.summary, supports_function_tools: true },
    tools: { ...base.tools, function_tools: capability('supported') },
  };
}

describe('runtime journey', () => {
  it('runs a model-to-workspace-tool-to-model journey with app payloads intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackbox-journey-'));
    temporaryDirectories.push(root);
    const workspace = await new LocalWorkspaceProvider().open({ kind: 'local', ref: root });
    await workspace.write('brief.txt', 'The launch date is Friday.');
    const call = createRunItem({
      type: 'function_call',
      provider: 'script',
      data: { name: 'workspace_read', call_id: 'read_1', arguments: { path: 'brief.txt' } },
    });
    const provider = new ScriptedModelProvider(
      [{ output_text: '', items: [call] }, { output_text: 'The launch date is Friday.' }],
      { id: 'script', capabilities: toolProfile },
    );
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new AgentRuntime({
      registry,
      tools: new ToolRegistry(workspaceToolDefinitions(workspace)),
    });

    const result = await runtime.run({
      model: 'script:model',
      input: 'Read the brief and report the launch date.',
      tools: ['workspace_read'],
    });

    expect(result.text).toBe('The launch date is Friday.');
    expect(result.payloads).toEqual([
      expect.objectContaining({ tool_name: 'workspace_read', call_id: 'read_1' }),
    ]);
    expect(provider.turns).toHaveLength(2);
  });
});
