import { createRuntimeId } from './ids.js';
import { ApprovalError } from './errors.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface ApprovalRequest {
  readonly action: string;
  readonly reason?: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly id: string;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
  readonly modified_arguments?: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ApprovalRecord {
  readonly request: ApprovalRequest;
  readonly decision?: ApprovalDecision;
}

export interface ApprovalTicket {
  readonly request: ApprovalRequest;
  readonly decision: Promise<ApprovalDecision>;
}

interface MutableApprovalRecord {
  readonly request: ApprovalRequest;
  decision?: ApprovalDecision;
  readonly waiters: Array<(decision: ApprovalDecision) => void>;
}

export class ApprovalManager {
  private readonly records = new Map<string, MutableApprovalRecord>();

  constructor(snapshot: Readonly<Record<string, ApprovalRecord>> = {}) {
    for (const [id, record] of Object.entries(snapshot)) {
      this.records.set(id, {
        request: structuredClone(record.request),
        decision: record.decision === undefined ? undefined : structuredClone(record.decision),
        waiters: [],
      });
    }
  }

  request(
    action: string,
    options: {
      readonly id?: string;
      readonly reason?: string;
      readonly data?: Readonly<Record<string, unknown>>;
    } = {},
  ): ApprovalTicket {
    const request = createApprovalRequest(action, options);
    if (this.records.has(request.id)) {
      throw new ApprovalError(`Approval '${request.id}' already exists.`, {
        code: 'approval_duplicate',
      });
    }
    const record: MutableApprovalRecord = { request, waiters: [] };
    this.records.set(request.id, record);
    return { request, decision: this.wait(request.id) };
  }

  wait(approvalId: string): Promise<ApprovalDecision> {
    const record = this.require(approvalId);
    if (record.decision !== undefined) return Promise.resolve(structuredClone(record.decision));
    return new Promise((resolve) => record.waiters.push(resolve));
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    const record = this.require(approvalId);
    if (record.decision !== undefined) {
      throw new ApprovalError(`Approval '${approvalId}' has already been decided.`, {
        code: 'approval_already_decided',
      });
    }
    record.decision = structuredClone(decision);
    for (const resolve of record.waiters.splice(0)) resolve(structuredClone(decision));
  }

  pending(): readonly ApprovalRequest[] {
    return [...this.records.values()]
      .filter((record) => record.decision === undefined)
      .map((record) => structuredClone(record.request));
  }

  snapshot(): Readonly<Record<string, ApprovalRecord>> {
    return Object.fromEntries(
      [...this.records].map(([id, record]) => [
        id,
        {
          request: structuredClone(record.request),
          decision: record.decision === undefined ? undefined : structuredClone(record.decision),
        },
      ]),
    );
  }

  private require(approvalId: string): MutableApprovalRecord {
    const record = this.records.get(approvalId);
    if (record === undefined) {
      throw new ApprovalError(`Approval '${approvalId}' is unknown.`, {
        code: 'approval_unknown',
      });
    }
    return record;
  }
}

export function createApprovalRequest(
  action: string,
  options: {
    readonly id?: string;
    readonly reason?: string;
    readonly data?: Readonly<Record<string, unknown>>;
  } = {},
): ApprovalRequest {
  return {
    action,
    reason: options.reason,
    data: options.data ?? {},
    id: options.id ?? createRuntimeId('approval'),
  };
}

export function approve(
  reason?: string,
  options: {
    readonly modified_arguments?: Readonly<Record<string, unknown>>;
    readonly metadata?: Readonly<Record<string, unknown>>;
  } = {},
): ApprovalDecision {
  return {
    approved: true,
    reason,
    modified_arguments: options.modified_arguments,
    metadata: options.metadata ?? {},
  };
}

export function deny(
  reason?: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ApprovalDecision {
  return { approved: false, reason, metadata };
}
