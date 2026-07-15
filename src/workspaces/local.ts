import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ArtifactRef } from '../core/artifacts.js';
import type { ApprovalManager } from '../core/approvals.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { WorkspaceError } from '../core/errors.js';
import { createRuntimeId } from '../core/ids.js';
import type { Policy } from '../core/policy.js';
import { AllowAllPolicy } from '../core/policy.js';
import type {
  Workspace,
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceFile,
  WorkspacePatchOperation,
  WorkspaceProvider,
  WorkspaceSnapshot,
  WorkspaceOpenSpec,
  WorkspaceKind,
} from './types.js';

export interface LocalWorkspaceOptions {
  readonly policy?: Policy;
  readonly approval_manager?: ApprovalManager;
  readonly emit?: (event: AgentEvent) => void | Promise<void>;
  readonly max_output_bytes?: number;
}

export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly id = 'local';
  readonly kind = 'local' as const;

  constructor(private readonly options: LocalWorkspaceOptions = {}) {}

  async open(spec: WorkspaceOpenSpec): Promise<Workspace> {
    if (spec.kind !== 'local' && spec.kind !== 'git' && spec.kind !== 'artifact_bundle') {
      throw new WorkspaceError(`Local provider cannot open workspace kind '${spec.kind}'.`, {
        code: 'workspace_kind_mismatch',
      });
    }
    const requestedRoot = resolve(spec.ref);
    await mkdir(requestedRoot, { recursive: true });
    const root = await realpath(requestedRoot);
    const workspace = new LocalWorkspace(root, spec.readonly ?? false, this.options, spec.kind);
    await workspace.emit(AgentEventTypes.WORKSPACE_OPENED, { root });
    return workspace;
  }
}

export class LocalWorkspace implements Workspace {
  readonly id = createRuntimeId('ws');
  readonly kind: WorkspaceKind;
  readonly readonly: boolean;
  private readonly snapshots = new Map<string, WorkspaceSnapshot>();
  private readonly policy: Policy;
  private readonly maxOutputBytes: number;

  constructor(
    readonly root: string,
    readonlyMode = false,
    private readonly options: LocalWorkspaceOptions = {},
    kind: WorkspaceKind = 'local',
  ) {
    this.readonly = readonlyMode;
    this.kind = kind;
    this.policy = options.policy ?? new AllowAllPolicy();
    this.maxOutputBytes = options.max_output_bytes ?? 1024 * 1024;
  }

  async read(path: string): Promise<Uint8Array> {
    const target = await this.resolvePath(path);
    await this.authorize('before_workspace_read', 'workspace.read', { path });
    const content = await readFile(target);
    await this.emit(AgentEventTypes.WORKSPACE_FILE_READ, { path, size: content.byteLength });
    return content;
  }

  async write(path: string, content: Uint8Array | string): Promise<void> {
    this.assertWritable();
    const target = await this.resolvePath(path);
    await this.authorize('before_workspace_write', 'workspace.write', { path });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    await this.emit(AgentEventTypes.WORKSPACE_FILE_CHANGED, { path, operation: 'write' });
  }

  async delete(path: string): Promise<void> {
    this.assertWritable();
    const target = await this.resolvePath(path);
    await this.authorize('before_workspace_write', 'workspace.delete', { path });
    await rm(target, { recursive: true, force: true });
    await this.emit(AgentEventTypes.WORKSPACE_FILE_CHANGED, { path, operation: 'delete' });
  }

  async list(path = '.'): Promise<readonly WorkspaceFile[]> {
    const start = await this.resolvePath(path);
    const files: WorkspaceFile[] = [];
    await walk(start, async (absolute, directory) => {
      const details = await stat(absolute);
      files.push({
        path: normalizeRelative(relative(this.root, absolute)),
        size: details.size,
        modified_at: details.mtime.toISOString(),
        directory,
      });
    });
    await this.emit(AgentEventTypes.WORKSPACE_FILE_LISTED, { path, count: files.length });
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async command(command: WorkspaceCommand): Promise<WorkspaceCommandResult> {
    await this.authorize('before_command', command.program, {
      arguments: command.arguments ?? [],
      cwd: command.cwd,
    });
    const cwd = await this.resolvePath(command.cwd ?? '.');
    await this.emit(AgentEventTypes.WORKSPACE_COMMAND_STARTED, {
      program: command.program,
      arguments: command.arguments ?? [],
    });
    const result = await runCommand(command, cwd, this.maxOutputBytes);
    await this.emit(AgentEventTypes.WORKSPACE_COMMAND_COMPLETED, {
      program: command.program,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
    });
    return result;
  }

  async applyPatch(operations: readonly WorkspacePatchOperation[]): Promise<void> {
    this.assertWritable();
    await Promise.all(operations.map(async (operation) => this.resolvePath(operation.path)));
    for (const operation of operations) {
      if (operation.operation === 'write') await this.write(operation.path, operation.content);
      else await this.delete(operation.path);
    }
    await this.emit(AgentEventTypes.WORKSPACE_PATCH_CREATED, { operations: operations.length });
  }

  async snapshot(metadata: Readonly<Record<string, unknown>> = {}): Promise<WorkspaceSnapshot> {
    const files: Record<string, string> = {};
    for (const file of await this.list()) {
      if (!file.directory)
        files[file.path] = Buffer.from(await this.read(file.path)).toString('base64');
    }
    const id = `snapshot_${createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 24)}`;
    const snapshot = { id, created_at: new Date().toISOString(), files, metadata };
    this.snapshots.set(id, snapshot);
    await this.emit(AgentEventTypes.WORKSPACE_SNAPSHOT_CREATED, { snapshot_id: id });
    return snapshot;
  }

  async restore(snapshot: WorkspaceSnapshot): Promise<void> {
    this.assertWritable();
    await this.authorize('before_workspace_restore', 'workspace.restore', {
      snapshot_id: snapshot.id,
    });
    const existing = await this.list();
    for (const file of existing.filter((entry) => !entry.directory)) await this.delete(file.path);
    for (const [path, content] of Object.entries(snapshot.files)) {
      await this.write(path, Buffer.from(content, 'base64'));
    }
    await this.emit(AgentEventTypes.WORKSPACE_SNAPSHOT_RESTORED, { snapshot_id: snapshot.id });
  }

  async artifacts(): Promise<readonly ArtifactRef[]> {
    return (await this.list())
      .filter((file) => !file.directory)
      .map((file) => ({ id: createRuntimeId('art'), provider: 'local', uri: file.path }));
  }

  async close(): Promise<void> {
    await this.emit(AgentEventTypes.WORKSPACE_CLOSED, {});
  }

  async emit(type: string, data: Readonly<Record<string, unknown>>): Promise<void> {
    await this.options.emit?.(createAgentEvent({ type, data: { workspace_id: this.id, ...data } }));
  }

  private async resolvePath(path: string): Promise<string> {
    if (isAbsolute(path)) throw traversalError(path);
    const target = resolve(this.root, path);
    if (!isContained(this.root, target)) throw traversalError(path);

    let existing = target;
    while (true) {
      try {
        const actual = await realpath(existing);
        if (!isContained(this.root, actual)) throw traversalError(path);
        break;
      } catch (cause) {
        if (!isNotFound(cause)) throw cause;
        const parent = dirname(existing);
        if (parent === existing || !isContained(this.root, parent)) throw traversalError(path);
        existing = parent;
      }
    }
    return target;
  }

  private assertWritable(): void {
    if (this.readonly) {
      throw new WorkspaceError('Workspace is read-only.', { code: 'workspace_readonly' });
    }
  }

  private async authorize(
    checkpoint: Parameters<Policy['check']>[0]['checkpoint'],
    action: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const decision = await this.policy.check({
      checkpoint,
      action,
      arguments: arguments_,
      metadata: {},
    });
    if (decision.verdict === 'allow') return;
    if (decision.verdict === 'require_approval' && this.options.approval_manager !== undefined) {
      const ticket = this.options.approval_manager.request(action, {
        reason: decision.reason,
        data: { checkpoint, arguments: arguments_, policy_metadata: decision.metadata },
      });
      await this.emit(AgentEventTypes.APPROVAL_REQUESTED, { request: ticket.request });
      const approval = await ticket.decision;
      await this.emit(
        approval.approved ? AgentEventTypes.APPROVAL_APPROVED : AgentEventTypes.APPROVAL_DENIED,
        { approval_id: ticket.request.id, decision: approval },
      );
      if (approval.approved) return;
      throw new WorkspaceError(approval.reason ?? `Workspace action '${action}' was denied.`, {
        code: 'approval_denied',
      });
    }
    throw new WorkspaceError(decision.reason ?? `Workspace action '${action}' was not allowed.`, {
      code: decision.verdict === 'deny' ? 'policy_denied' : 'approval_required',
    });
  }
}

async function walk(
  path: string,
  visit: (path: string, directory: boolean) => void | Promise<void>,
): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    await visit(child, entry.isDirectory());
    if (entry.isDirectory()) await walk(child, visit);
  }
}

function runCommand(
  command: WorkspaceCommand,
  cwd: string,
  maxOutputBytes: number,
): Promise<WorkspaceCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.program, command.arguments ?? [], {
      cwd,
      env: { ...process.env, ...command.env },
      shell: false,
      windowsHide: true,
      signal: command.signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const append = (target: Buffer[], chunk: Buffer) => {
      if (bytes >= maxOutputBytes) return;
      const remaining = maxOutputBytes - bytes;
      const value = chunk.subarray(0, remaining);
      target.push(value);
      bytes += value.byteLength;
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    const timer =
      command.timeout_ms === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, command.timeout_ms);
    child.once('error', (cause) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(
        command.signal?.aborted === true
          ? new WorkspaceError('Workspace command was cancelled.', {
              code: 'workspace_command_cancelled',
              cause,
            })
          : new WorkspaceError(`Workspace command '${command.program}' failed to start.`, {
              code: 'workspace_command_failed',
              cause,
            }),
      );
    });
    child.once('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({
        exit_code: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timed_out: timedOut,
      });
    });
  });
}

function traversalError(path: string): WorkspaceError {
  return new WorkspaceError(`Workspace path '${path}' escapes the workspace root.`, {
    code: 'workspace_path_traversal',
  });
}

function normalizeRelative(path: string): string {
  return path.split(sep).join('/');
}

function isContained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function isNotFound(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === 'ENOENT';
}
