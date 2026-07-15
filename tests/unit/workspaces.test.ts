import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentEventTypes,
  AgentRuntime,
  ApprovalManager,
  ArtifactBundleWorkspaceProvider,
  CloudWorkspaceProvider,
  DockerWorkspaceProvider,
  GitWorkspaceProvider,
  LocalWorkspaceProvider,
  SandboxWorkspaceProvider,
  allow,
  approve,
  requireApproval,
  workspaceToolDefinitions,
  type AgentEvent,
} from '../../src/index.js';

const execFileAsync = promisify(execFile);

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

    const timedOut = await workspace.command({
      program: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 1000)'],
      timeout_ms: 10,
    });
    expect(timedOut.timed_out).toBe(true);

    const controller = new AbortController();
    const cancelled = workspace.command({
      program: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 1000)'],
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'workspace_command_cancelled' });
  });

  it('rejects filesystem-link escapes as well as lexical traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackbox-workspace-contained-'));
    const outside = await mkdtemp(join(tmpdir(), 'blackbox-workspace-outside-'));
    temporaryDirectories.push(root, outside);
    await writeFile(join(outside, 'secret.txt'), 'outside', 'utf8');
    await symlink(outside, join(root, 'linked'), 'junction');
    const workspace = await new LocalWorkspaceProvider().open({ kind: 'local', ref: root });

    await expect(workspace.read('linked/secret.txt')).rejects.toMatchObject({
      code: 'workspace_path_traversal',
    });
    await expect(workspace.write('linked/new.txt', 'escape')).rejects.toMatchObject({
      code: 'workspace_path_traversal',
    });
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

  it('manages workspaces through the runtime facade and gates open before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackbox-workspace-runtime-'));
    temporaryDirectories.push(root);
    const approvals = new ApprovalManager();
    const runtime = new AgentRuntime({
      workspace_approvals: approvals,
      policy: {
        check: ({ checkpoint }) =>
          checkpoint === 'before_workspace_open' ? requireApproval('review open') : allow(),
      },
    });
    const opening = runtime.workspaces.open({ kind: 'local', ref: root });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const pending = approvals.pending()[0];
    if (pending === undefined) throw new Error('Workspace open approval was not requested.');
    approvals.decide(pending.id, approve());
    const workspace = await opening;

    expect(runtime.workspaces.get(workspace.id)).toBe(workspace);
    expect(runtime.workspaces.list()).toEqual([workspace]);
    await runtime.workspaces.close(workspace.id);
    expect(runtime.workspaces.list()).toEqual([]);
  });

  it('checks out an explicit git ref and preserves the git workspace kind', async () => {
    const origin = await mkdtemp(join(tmpdir(), 'blackbox-git-origin-'));
    const checkouts = await mkdtemp(join(tmpdir(), 'blackbox-git-checkouts-'));
    temporaryDirectories.push(origin, checkouts);
    await execFileAsync('git', ['init', origin], { windowsHide: true });
    await writeFile(join(origin, 'version.txt'), 'one', 'utf8');
    await execFileAsync('git', ['-C', origin, 'add', 'version.txt'], { windowsHide: true });
    await execFileAsync(
      'git',
      [
        '-C',
        origin,
        '-c',
        'user.name=Blackbox Test',
        '-c',
        'user.email=blackbox@example.invalid',
        'commit',
        '-m',
        'first',
      ],
      { windowsHide: true },
    );
    await execFileAsync('git', ['-C', origin, 'tag', 'fixture-v1'], { windowsHide: true });
    await writeFile(join(origin, 'version.txt'), 'two', 'utf8');
    await execFileAsync('git', ['-C', origin, 'add', 'version.txt'], { windowsHide: true });
    await execFileAsync(
      'git',
      [
        '-C',
        origin,
        '-c',
        'user.name=Blackbox Test',
        '-c',
        'user.email=blackbox@example.invalid',
        'commit',
        '-m',
        'second',
      ],
      { windowsHide: true },
    );

    const workspace = await new GitWorkspaceProvider(checkouts).open({
      kind: 'git',
      ref: origin,
      metadata: { name: 'fixture', ref: 'fixture-v1' },
    });

    expect(workspace.kind).toBe('git');
    expect(Buffer.from(await workspace.read('version.txt')).toString()).toBe('one');

    await expect(
      new GitWorkspaceProvider(checkouts).open({
        kind: 'git',
        ref: origin,
        metadata: { name: 'missing-ref', ref: 'does-not-exist' },
      }),
    ).rejects.toMatchObject({ code: 'workspace_git_checkout_failed' });
  });

  it('keeps injected provider kinds honest and opaque cloud operations unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackbox-artifact-bundle-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'artifact.txt'), 'immutable', 'utf8');
    const artifact = await new ArtifactBundleWorkspaceProvider().open({
      kind: 'artifact_bundle',
      ref: root,
    });
    expect(artifact).toMatchObject({ kind: 'artifact_bundle', readonly: true });
    await expect(artifact.write('new.txt', 'no')).rejects.toMatchObject({
      code: 'workspace_readonly',
    });

    const open = vi.fn(() => artifact);
    const sandbox = new SandboxWorkspaceProvider({ open });
    const docker = new DockerWorkspaceProvider({ open });
    expect(() => sandbox.open({ kind: 'docker', ref: 'wrong' })).toThrowError(
      expect.objectContaining({
        code: 'workspace_kind_mismatch',
      }),
    );
    expect(() => docker.open({ kind: 'sandbox', ref: 'wrong' })).toThrowError(
      expect.objectContaining({
        code: 'workspace_kind_mismatch',
      }),
    );
    expect(await sandbox.open({ kind: 'sandbox', ref: 'sandbox' })).toBe(artifact);
    expect(await docker.open({ kind: 'docker', ref: 'docker' })).toBe(artifact);

    const cloud = await new CloudWorkspaceProvider('cloud-test').open({
      kind: 'cloud',
      ref: 'opaque-id',
    });
    expect(cloud).toMatchObject({ kind: 'cloud', readonly: true });
    await expect(cloud.read('file.txt')).rejects.toMatchObject({
      code: 'workspace_operation_unsupported',
    });
  });
});
