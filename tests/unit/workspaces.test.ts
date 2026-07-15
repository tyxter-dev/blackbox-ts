import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentEventTypes,
  ApprovalManager,
  LocalWorkspaceProvider,
  allow,
  approve,
  requireApproval,
  workspaceToolDefinitions,
  type AgentEvent,
} from '../../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('local workspace', () => {
  it('contains paths, applies patches, snapshots, restores, and emits events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackbox-workspace-'));
    temporaryDirectories.push(root);
    const events: AgentEvent[] = [];
    const workspace = await new LocalWorkspaceProvider({
      emit: (event) => events.push(event),
    }).open({
      kind: 'local',
      ref: root,
    });

    await workspace.write('nested/file.txt', 'one');
    await expect(workspace.read('../outside.txt')).rejects.toMatchObject({
      code: 'workspace_path_traversal',
    });
    const snapshot = await workspace.snapshot({ label: 'one' });
    await workspace.applyPatch([{ operation: 'write', path: 'nested/file.txt', content: 'two' }]);
    expect(Buffer.from(await workspace.read('nested/file.txt')).toString()).toBe('two');
    await workspace.restore(snapshot);

    expect(Buffer.from(await workspace.read('nested/file.txt')).toString()).toBe('one');
    expect((await workspace.artifacts()).map((artifact) => artifact.uri)).toContain(
      'nested/file.txt',
    );
    expect(events.some((event) => event.type === AgentEventTypes.WORKSPACE_SNAPSHOT_CREATED)).toBe(
      true,
    );
    expect(workspaceToolDefinitions(workspace).map((tool) => tool.name)).toEqual([
      'workspace_read',
      'workspace_list',
      'workspace_write',
      'workspace_command',
    ]);
  });

  it('executes argument-safe commands and enforces output caps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackbox-workspace-'));
    temporaryDirectories.push(root);
    const workspace = await new LocalWorkspaceProvider({ max_output_bytes: 4 }).open({
      kind: 'local',
      ref: root,
    });

    const result = await workspace.command({
      program: process.execPath,
      arguments: ['-e', 'process.stdout.write("abcdefgh")'],
    });

    expect(result).toMatchObject({ exit_code: 0, stdout: 'abcd', timed_out: false });
  });

  it('pauses governed workspace mutations for an approval decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackbox-workspace-approval-'));
    temporaryDirectories.push(root);
    const approvals = new ApprovalManager();
    const events: AgentEvent[] = [];
    const workspace = await new LocalWorkspaceProvider({
      approval_manager: approvals,
      policy: {
        check: ({ checkpoint }) =>
          checkpoint === 'before_workspace_write' ? requireApproval('review write') : allow(),
      },
      emit: (event) => events.push(event),
    }).open({ kind: 'local', ref: root });

    const write = workspace.write('approved.txt', 'ok');
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const request = approvals.pending()[0];
    if (request === undefined) throw new Error('Approval was not requested.');
    approvals.decide(request.id, approve('reviewed'));
    await write;

    expect(Buffer.from(await workspace.read('approved.txt')).toString()).toBe('ok');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        AgentEventTypes.APPROVAL_REQUESTED,
        AgentEventTypes.APPROVAL_APPROVED,
      ]),
    );
  });
});
