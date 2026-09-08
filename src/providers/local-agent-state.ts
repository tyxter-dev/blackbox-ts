import type { AgentProvider } from './agent.js';

const sessionLookups = new WeakMap<AgentProvider, (sessionId: string) => boolean>();

export function registerLocalSessionLookup(
  provider: AgentProvider,
  lookup: (sessionId: string) => boolean,
): void {
  sessionLookups.set(provider, lookup);
}

export function hasLocalSession(provider: AgentProvider, sessionId: string): boolean {
  return sessionLookups.get(provider)?.(sessionId) ?? false;
}
