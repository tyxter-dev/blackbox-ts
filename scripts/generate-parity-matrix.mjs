import { access, readFile, writeFile } from 'node:fs/promises';

const inventoryUrl = new URL('../docs/parity-inventory.json', import.meta.url);
const outputUrl = new URL('../docs/PARITY_MATRIX.md', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));

const domainEvidence = {
  'High-Level Runtime': entry(
    ['src/runtime/agent-loop.ts', 'src/runtime/agent-runtime.ts'],
    ['tests/unit/agent-loop.test.ts', 'tests/journey/runtime-journey.test.ts'],
  ),
  'Skills and Workspace Agents': entry(
    ['src/workspace-agents', 'src/skills', 'src/schedules'],
    ['tests/unit/workspace-agents.test.ts'],
  ),
  'Structured Output': entry(
    ['src/output', 'src/core/results.ts', 'src/runtime/agent-loop.ts'],
    ['tests/unit/tools-output.test.ts', 'tests/unit/agent-loop.test.ts'],
  ),
  'Local Tools': entry(['src/tools'], ['tests/unit/tools-output.test.ts']),
  'Hosted Tools': entry(
    ['src/providers', 'src/runtime/agent-loop.ts'],
    ['tests/golden/providers.test.ts', 'tests/unit/agent-loop.test.ts'],
  ),
  'Policy, Approvals, and Safety': entry(
    ['src/core/policy.ts', 'src/core/approvals.ts', 'src/runtime/agent-loop.ts'],
    ['tests/unit/core-contracts.test.ts', 'tests/unit/agent-loop.test.ts'],
  ),
  'Core Events and State': entry(['src/core'], ['tests/unit/core-contracts.test.ts']),
  'Provider State Mapping': entry(['src/providers'], ['tests/golden/providers.test.ts']),
  Persistence: entry(['src/persistence'], ['tests/unit/persistence-observability.test.ts']),
  'Provider Controls and Catalog': entry(
    ['src/core/capabilities.ts', 'src/providers/catalog.ts'],
    ['tests/unit/capabilities.test.ts', 'tests/unit/registry-catalog.test.ts'],
  ),
  'Accounting and Cache': entry(
    ['src/core/usage.ts', 'src/pricing', 'src/cache'],
    ['tests/unit/planning-accounting-config.test.ts'],
  ),
  'Granular Model Capabilities': entry(
    ['src/core/capabilities.ts'],
    ['tests/unit/capabilities.test.ts', 'tests/unit/provider-contracts.test.ts'],
  ),
  'Provider Runtime': entry(
    ['src/providers', 'src/runtime/model-runtime.ts'],
    ['tests/unit/provider-contracts.test.ts', 'tests/unit/model-runtime.test.ts'],
  ),
  'Native Model Providers': entry(['src/providers'], ['tests/golden/providers.test.ts']),
  'Agent Sessions': entry(
    ['src/runtime/agent-sessions.ts', 'src/providers/local-agent.ts', 'src/providers/cloud-agents.ts'],
    ['tests/unit/agent-sessions.test.ts'],
  ),
  'Environment Workers': entry(['src/workers'], ['tests/unit/workers-observability.test.ts']),
  Artifacts: entry(['src/core/artifacts.ts'], ['tests/unit/core-contracts.test.ts']),
  Workspaces: entry(['src/workspaces'], ['tests/unit/workspaces.test.ts']),
  MCP: entry(['src/mcp'], ['tests/unit/mcp.test.ts', 'tests/security/boundaries.test.ts']),
  Observability: entry(
    ['src/observability'],
    ['tests/unit/workers-observability.test.ts', 'tests/unit/persistence-observability.test.ts'],
  ),
  Realtime: entry(
    ['src/realtime', 'src/runtime/realtime-runtime.ts', 'src/providers/duplex-realtime.ts'],
    ['tests/unit/realtime.test.ts'],
  ),
  'Runtime Configuration': entry(['src/config'], ['tests/unit/planning-accounting-config.test.ts']),
  'Prompt Planning': entry(['src/planning'], ['tests/unit/planning-accounting-config.test.ts']),
  'Workspace Providers and Security': entry(
    ['src/workspaces/local.ts', 'src/workspaces/providers.ts', 'src/workspaces/runtime.ts'],
    ['tests/unit/workspaces.test.ts', 'tests/security/boundaries.test.ts'],
  ),
  'Persistence Contracts': entry(
    ['src/persistence/jsonl.ts', 'src/persistence/sqlite.ts'],
    ['tests/unit/persistence-observability.test.ts'],
  ),
  'MCP Lifecycle Security': entry(
    ['src/mcp/client.ts', 'src/mcp/transports.ts'],
    ['tests/unit/mcp.test.ts', 'tests/security/boundaries.test.ts'],
  ),
  'Runtime Lifecycle Hardening': entry(
    ['src/runtime/agent-loop.ts', 'src/runtime/realtime-runtime.ts', 'src/tools/runtime.ts'],
    ['tests/unit/agent-loop.test.ts', 'tests/unit/realtime.test.ts'],
  ),
  'Package and Worker Hardening': entry(
    ['src/workspace-agents/package.ts', 'src/workers/index.ts'],
    ['tests/unit/workspace-agents.test.ts', 'tests/unit/workers-observability.test.ts'],
  ),
};

const featureEvidence = {
  'SQLite workspace agent registry': entry(
    ['src/workspace-agents/registry.ts'],
    ['tests/unit/workspace-agents.test.ts'],
  ),
  'Workspace agent validation': entry(
    ['src/workspace-agents/validation.ts'],
    ['tests/unit/workspace-agents.test.ts'],
  ),
  'Workspace agent package on disk': entry(
    ['src/workspace-agents/package.ts'],
    ['tests/unit/workspace-agents.test.ts', 'tests/security/boundaries.test.ts'],
  ),
  'Schedule execution (reference executor)': entry(
    ['src/schedules/index.ts'],
    ['tests/unit/workspace-agents.test.ts'],
  ),
  'JSONL/SQLite stores': entry(
    ['src/persistence/jsonl.ts', 'src/persistence/sqlite.ts'],
    ['tests/unit/persistence-observability.test.ts'],
  ),
  'Resume run from persisted state': entry(
    ['src/runtime/agent-runtime.ts', 'src/persistence/stores.ts'],
    ['tests/unit/persistence-observability.test.ts'],
  ),
  'Anthropic Managed Agents work source': entry(
    ['src/workers/index.ts'],
    ['tests/unit/workers-observability.test.ts'],
  ),
};

const releaseEvidence = [
  'tests/journey/runtime-journey.test.ts',
  'tests/security/boundaries.test.ts',
  'tests/perf/runtime-budget.test.ts',
  'docs/CAPABILITIES.md',
  'docs/public-api.json',
  'docs/catalog-snapshot.json',
  'scripts/package-smoke.mjs',
];
const rows = inventory.groups.flatMap((group) =>
  group.features.map((feature) => ({
    feature,
    domain: group.domain,
    phase: group.owner_phase,
    parent: group.parent_status,
    target: group.target_status,
    source: group.source,
  })),
);

const resolvedRows = rows.map((row) => {
  const resolved = featureEvidence[row.feature] ?? domainEvidence[row.domain];
  if (resolved === undefined) {
    throw new Error(`No parity evidence mapping exists for '${row.domain}: ${row.feature}'.`);
  }
  return { ...row, evidence: resolved };
});

await Promise.all(
  [
    ...new Set([
      ...resolvedRows.flatMap((row) => [...row.evidence.implementation, ...row.evidence.tests]),
      ...releaseEvidence,
    ]),
  ].map((path) => access(new URL(`../${path}`, import.meta.url))),
);

const lines = [
  '# Python/TypeScript Parity Matrix',
  '',
  `Generated from \`docs/parity-inventory.json\` against Python commit \`${inventory.parent_commit}\`. Do not edit this file by hand; run \`pnpm generate:parity\`.`,
  '',
  `Coverage: **${rows.length} tracked requirements** (${inventory.catalog_unique_feature_count} unique FEATURES.md items plus implementation supplements).`,
  '',
  '| Requirement | Domain | Phase | Python status | TypeScript target | Implementation evidence | Test evidence | Baseline |',
  '| --- | --- | ---: | --- | --- | --- | --- | --- |',
];

for (const row of resolvedRows) {
  lines.push(
    `| ${escapeCell(row.feature)} | ${escapeCell(row.domain)} | ${row.phase} | ${escapeCell(row.parent)} | ${escapeCell(row.target)} | ${renderLinks(row.evidence.implementation)} | ${renderLinks(row.evidence.tests)} | ${escapeCell(row.source)} |`,
  );
}
lines.push(
  '',
  '## Release evidence',
  '',
  ...releaseEvidence.map((path) => `- \`${path}\``),
);

const rendered = `${lines.join('\n')}\n`;
if (process.argv.includes('--check')) {
  const current = await readFile(outputUrl, 'utf8').catch(() => '');
  if (current !== rendered) {
    throw new Error('docs/PARITY_MATRIX.md is stale. Run pnpm generate:parity.');
  }
  console.log(`Parity matrix OK: ${rows.length} requirements have scoped implementation and test evidence.`);
} else {
  await writeFile(outputUrl, rendered, 'utf8');
  console.log(`Wrote parity matrix with ${rows.length} requirements.`);
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function entry(implementation, tests) {
  return { implementation, tests };
}

function renderLinks(paths) {
  return paths.map((path) => `[\`${escapeCell(path)}\`](../${path.replaceAll(' ', '%20')})`).join('<br>');
}
