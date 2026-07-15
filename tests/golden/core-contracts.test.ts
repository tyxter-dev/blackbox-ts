import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  createAgentEvent,
  createAgentSession,
  createApprovalRequest,
  createArtifact,
  createProviderState,
  createRunItem,
  modelUsage,
} from '../../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/python/core-contracts.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>;

describe('Python core contract fixtures', () => {
  it('reproduces Python-normalized durable values at the pinned commit', () => {
    expect(fixture.parent_commit).toBe('f27decbc9aeaae972c5bbeb256c70450b7fe393a');

    const event = createAgentEvent(compact(fixture.event));
    const item = createRunItem(compact(fixture.item));
    const state = createProviderState(compact(fixture.provider_state));
    const session = createAgentSession(compact(fixture.session));
    const approval = createApprovalRequest(
      String(fixture.approval_request.action),
      compact({
        id: fixture.approval_request.id,
        reason: fixture.approval_request.reason,
        data: fixture.approval_request.data,
      }),
    );
    const artifactFixture = (fixture.artifact_page.items as Record<string, unknown>[])[0];
    const artifact = createArtifact(compact(artifactFixture));
    const usage = modelUsage(fixture.usage);

    expect(event).toMatchObject(compact(fixture.event));
    expect(item).toMatchObject(compact(fixture.item));
    expect(state).toMatchObject(compact(fixture.provider_state));
    expect(session).toMatchObject(fixture.session);
    expect(approval).toMatchObject(fixture.approval_request);
    expect(artifact).toMatchObject(compact(artifactFixture));
    expect(usage).toEqual(fixture.usage);
    expect(event.raw).toEqual({ id: 'resp_fixture' });
    expect(item.raw).toEqual({ type: 'message' });
  });
});

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== null)) as T;
}
