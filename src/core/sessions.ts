import { createRuntimeId } from './ids.js';
import { SessionError, SessionTerminalError } from './errors.js';

export type SessionStatus =
  | 'created'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentRef {
  readonly provider: string;
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SessionRef {
  readonly provider: string;
  readonly id: string;
  readonly agent_id?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface InvocationRef {
  readonly provider: string;
  readonly session_id: string;
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentSession {
  readonly provider: string;
  readonly task: string;
  readonly agent_id?: string;
  readonly model?: string;
  readonly status: SessionStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly id: string;
}

export interface AgentSessionInput extends Omit<AgentSession, 'id' | 'status' | 'metadata'> {
  readonly id?: string;
  readonly status?: SessionStatus;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function createAgentSession(input: AgentSessionInput): AgentSession {
  return {
    ...input,
    status: input.status ?? 'created',
    metadata: input.metadata ?? {},
    id: input.id ?? createRuntimeId('sess'),
  };
}

export function sessionRef(session: AgentSession): SessionRef {
  return {
    provider: session.provider,
    id: session.id,
    agent_id: session.agent_id,
    metadata: session.metadata,
  };
}

const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  created: ['running', 'failed', 'cancelled'],
  running: ['waiting', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function transitionAgentSession(session: AgentSession, status: SessionStatus): AgentSession {
  if (session.status === status) return session;
  if (SESSION_TRANSITIONS[session.status].includes(status)) return { ...session, status };

  const message = `Session '${session.id}' cannot transition from '${session.status}' to '${status}'.`;
  const details = {
    session_id: session.id,
    provider: session.provider,
    status: session.status,
    operation: `transition:${status}`,
  };
  if (SESSION_TRANSITIONS[session.status].length === 0) {
    throw new SessionTerminalError(message, details);
  }
  throw new SessionError(message, details);
}

export function createInvocationRef(
  provider: string,
  sessionId: string,
  options: { readonly id?: string; readonly metadata?: Readonly<Record<string, unknown>> } = {},
): InvocationRef {
  return {
    provider,
    session_id: sessionId,
    id: options.id ?? createRuntimeId('inv'),
    metadata: options.metadata ?? {},
  };
}
