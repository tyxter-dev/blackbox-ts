import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { formatGenerated } from './lib/format-generated.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(repoRoot, 'docs/parity-test-crosswalk.json');
const inventory = JSON.parse(await readFile(resolve(repoRoot, 'docs/parity-inventory.json'), 'utf8'));
const baseline = JSON.parse(await readFile(resolve(repoRoot, 'docs/parent-baseline.json'), 'utf8'));
const parentTests = baseline.test_files.map((entry) => entry.path).sort();
const parentGroups = inventory.groups.filter((group) => group.classification === 'parent');
const parentDomains = [...new Set(parentGroups.map((group) => group.domain))];

const explicitEvidence = new Map();
for (const [ref, evidence] of Object.entries(inventory.evidence)) {
  for (const pythonTest of evidence.parent.tests) {
    const entry = explicitEvidence.get(pythonTest) ?? { refs: [], typescript: new Set() };
    entry.refs.push(ref);
    for (const test of evidence.typescript.tests) entry.typescript.add(test);
    explicitEvidence.set(pythonTest, entry);
  }
}

/**
 * Recorded TypeScript divergences and honest N/A surfaces, keyed by the parent
 * test module that exercises the parent behaviour. Each note is true at the
 * pinned parent commit and the current TypeScript tree; they are carried on the
 * crosswalk so a reviewer sees the gap next to the test it maps from.
 */
const DIVERGENCE_NOTES = {
  'tests/unit/providers/model_adapters/test_current_model_controls.py': [
    "TS `mergeExtra` hard-rejects `extra.model` (ConfigurationError), so no effective-model override exists: the parametrizations test_astra_restricted_parameters_fail_before_sdk[model_override], test_current_invalid_cache_fails_before_sdk[model_override], and the override half of test_cache_mapping_uses_effective_model_and_preserves_legacy have no TS equivalent.",
    "The TS xAI capability profile advertises `cache_ttl` and `top_logprobs` keys the parent xAI profile lacks; the legacy OpenAI reasoning-effort list stays narrower than the parent advisory list; a legacy-model `cache.ttl` + `extra.prompt_cache_retention` combination collides in TS where the parent previously ignored the field.",
    "Anthropic legacy `reasoning_effort` advertises native_name `thinking` (parent: `thinking.budget_tokens`) with a narrower supported_values list; the parent's `_merge_output_config` merges while TS `mergeExtra` reports a collision.",
    "The TS fable replay guard binds system + tools + the recorded assistant prefix only; the parent additionally binds the full prior conversation for fable-5-1.",
  ],
  'tests/unit/core/test_pricing_catalog.py': [
    "TS `PricingEntry` has no `source_url` or `reasoning_output_per_million` and collapses `cached_input`/`cache_read_input` into one read rate; `PricingCatalog.get` performs no alias resolution (parent `_register_provider_model_aliases`), so an alias such as `openai:gpt-5.6` prices as `pricing_not_found`.",
  ],
  'tests/runtime/test_package_permissions.py': [
    "TS has no client-executed hosted tools, so the parent hosted_runtime execution-time package/user gate has no counterpart; only the model-configuration gate applies.",
    "A package-denied loop call still emits TOOL_CALL_REQUESTED/STARTED and TOOL_CALL_FAILED before TOOL_CHOICE_REJECTED (the parent short-circuits with only the rejection); a user-policy deny or denied approval ticket throws ApprovalError and ends the run (the parent continues with a failed item); an unregistered call name under a boundary ends as tool_not_found without TOOL_CHOICE_REJECTED.",
    "`load` reports refused names as `denied`/`denied_by_package` on its payload with no per-load run event (the parent emits an `invalid` list plus a run-visible event).",
    "Workspace canonical refs are `workspace:read|list|write|command` (parent: `workspace:read_file|list_files|write_file|run_command`), so a literal parent workspace grant does not match a TS workspace tool.",
    "MCP `connector_scopes` derive from the descriptor `required_scopes` only (the parent also unions the host trust blob and `metadata.scopes`); the in-process MCPServer `tools/list` omits descriptor metadata, so a connector-bound definition served in-process is never admitted (fail-closed).",
    "Realtime `connect` passes tool definitions and hosted tools to the provider unfiltered (parent-faithful); dispatch still denies but realtime hosted tools have no dispatch backstop.",
    "`AgentRuntime.stream` validates the request synchronously at call time rather than at first pull.",
  ],
  'tests/runtime/test_package_permission_regressions.py': [
    "Custom workspace prefixes compose against the TS operation names `read|list|write|command`, not the parent's `read_file|list_files|write_file|run_command`.",
  ],
  'tests/unit/workspace_agents/test_permission_enforcement.py': [
    "The parent stores grants under `permissions`; TS stores them under `grants` (R15), so a parent-written allowlist_v1 package fails closed in TS.",
    "MCP descriptor `annotations.readOnlyHint`/`destructiveHint` map to `metadata.read_only`/`destructive` as booleans only (an explicit metadata key wins; the parent's whole-object `annotations` copy is not ported); the descriptor `scopes` array is an extra scope-ladder rung with no parent counterpart.",
  ],
  'tests/contracts/test_package_permission_capabilities.py': [
    "Any agent adapter not advertising `supports_package_permissions` (including test fakes) is refused under a boundary; `AgentSessionsRuntime.stream` under a boundary resolves the provider eagerly (ProviderNotFoundError at call rather than SessionNotFoundError at first pull).",
  ],
  'tests/e2e/test_permissioned_package.py': [
    "Portable-package interchange differs (`grants` vs parent `permissions`); the agent-provider path of `runWorkspaceAgent` carries tools, hosted tools, workspace, and policy on `AgentSpec.metadata.run_request` and writes the effective model/instructions onto the spec (TS-only local-adapter convention).",
  ],
  'tests/runtime/test_codex_agent_provider.py': [
    "Contract port only (ruling F4): the TS client boundary is connection-level (`connect` -> `send`/`messages`/`close`) while the parent `CodexAppServerClient` protocol is session-level; the provider owns thread/turn requests and the normalization table. No child-process/SDK runtime: inherited-env stripping, bundled PATH, `codex_bin`/SDK version check, kill grace, stderr tail, and the include-normalization compat registry are honestly N/A.",
    "`supports_resume` is forced false (the parent forces only package permissions); `supports_follow_up` true is TS-only; `metadata.codex_sdk_version` names the pinned protocol version; parent `permissions`/`extra` options are read from TS `metadata` (`AgentSpec.metadata.id/.sandbox`, `TaskSpec.metadata.ephemeral/.sandbox`, `WorkspaceSpec.metadata.root`).",
    "Fail-closed deviations: numeric JSON-RPC request ids are answered (parent ignores them); a duplicate pending approval id is refused with -32000 (parent overwrites); pending approvals are dropped on close and on reader failure with an explicit unknown-approval error afterwards; after a reader fault the connection is write-closed and `cancel` skips the interrupt.",
  ],
  'tests/golden/codex/test_app_server_event_mapping.py': [
    "The buffered `blackbox/session/started` entry is unreachable by any cursor (parent quirk kept).",
    "Private `blackbox/*` notifications are non-authoritative logs in TypeScript, unlike the parent's string-only mapping. Only adapter-synthesized objects receive private lifecycle/approval authority; raw wire fields cannot assert provenance. Logs retain raw payloads without creating durable approvals or replacing provider state; native approval requests and cancellation/failure paths remain supported.",
  ],
  'tests/integration/codex/test_codex_subscription.py': [
    "Honest N/A: TS has no Codex child-process/SDK runtime (ruling F4); the subscription-only guard is exercised against the injected client, not a live app-server.",
  ],
  'tests/runtime/test_agent_session_run.py': [
    "`AgentSessionsRuntime.run` output for a Codex session is '' (TS derives text from SESSION_COMPLETED/AGENT_RESPONSE_MESSAGE_CREATED, not deltas), unlike the parent test_agents_run_collects_a_codex_app_server_session.",
  ],
  'tests/runtime/test_claude_code_agent_provider.py': [
    "The Claude task-budget contract ports only `_normalize_task_budget`, applied at `ClaudeCodeAgentProvider.startSession` to `task.metadata.task_budget`; per-turn MODEL_REQUEST_STARTED emission, model precedence, process/SDK machinery, and the agent-level `permissions.task_budget` precedence are honestly N/A; JS admits `1.0`/`1e6` as integers where the parent rejects floats.",
  ],
  'tests/unit/mcp/test_mcp_client.py': [
    "`clientInfo` is `blackbox-ts` at version 0.2.0 (ruling R6); `listTools` coalesces in-flight fetches (concurrent cold callers emit one MCP_LIST_TOOLS pair) and preserves descriptor identity across unchanged refetches; only boolean `annotations.readOnlyHint`/`destructiveHint` hints are mapped.",
  ],
  'tests/unit/mcp/test_mcp_server.py': [
    "`serverInfo.version` is `0.2.0` (parent-mirrored, R18); `serverInfo.name` is the configured server name exactly as in the parent, and only `clientInfo.name` diverges (`blackbox-ts`, ruling R6); the in-process `tools/list` still omits descriptor metadata.",
  ],
  'tests/unit/skills/test_skills.py': [
    "The frontmatter fallback parser mirrors the parent YAML-subset block grammar; inline flow scalars (`[a, b]`, `{ k: v }`, `~`, single quotes) remain JSON-only, so the parent's hand-written SKILL.md fixture still does not parse in TS.",
  ],
};

if (process.argv.includes('--parent')) await validateParentCheckout(parentTests);

for (const pythonTest of Object.keys(DIVERGENCE_NOTES)) {
  if (!parentTests.includes(pythonTest)) {
    throw new Error(`Divergence note references unknown parent test module ${pythonTest}.`);
  }
}

const entries = parentTests.map((pythonTest) => {
  const explicit = explicitEvidence.get(pythonTest);
  const domains = explicit?.refs.map(domainForEvidence).filter(unique) ?? [];
  const inferred = inferMapping(pythonTest);
  return {
    id: `python-test.${slug(pythonTest)}`,
    python_test: pythonTest,
    classification: classify(pythonTest),
    coverage: explicit === undefined ? 'semantic_projection' : 'direct_evidence',
    domains: domains.length === 0 ? inferred.domains : domains,
    evidence_refs: explicit?.refs ?? [],
    typescript_tests:
      explicit === undefined ? inferred.tests : [...explicit.typescript].sort(),
    notes: DIVERGENCE_NOTES[pythonTest] ?? [],
  };
});

const missingDomains = parentDomains.filter(
  (domain) => !entries.some((entry) => entry.domains.includes(domain)),
);
if (missingDomains.length > 0) {
  throw new Error(`Crosswalk has no Python test coverage for domains: ${missingDomains.join(', ')}.`);
}
for (const entry of entries) {
  if (entry.typescript_tests.length === 0) throw new Error(`${entry.python_test} has no TS tests.`);
  for (const test of entry.typescript_tests) {
    await access(resolve(repoRoot, ...test.split('/'))).catch(() => {
      throw new Error(`${entry.python_test} references missing TypeScript test ${test}.`);
    });
  }
}

const classifications = Object.fromEntries(
  ['semantic', 'sdk_protocol_fixture', 'integration_smoke', 'partial_contract_negative'].map(
    (classification) => [
      classification,
      entries.filter((entry) => entry.classification === classification).length,
    ],
  ),
);
const document = {
  schema_version: 1,
  parent_repository: inventory.parent.repository,
  parent_commit: inventory.parent.commit,
  generated_from: 'docs/parent-baseline.json',
  summary: {
    python_test_modules: entries.length,
    direct_evidence: entries.filter((entry) => entry.coverage === 'direct_evidence').length,
    semantic_projections: entries.filter((entry) => entry.coverage === 'semantic_projection').length,
    domains_covered: parentDomains.length,
    classifications,
    entries_with_notes: entries.filter((entry) => entry.notes.length > 0).length,
  },
  entries,
  feature_coverage: parentGroups.flatMap((group) =>
    group.features.map((feature) => {
      const evidenceRef = feature.evidence[0];
      return {
        feature_id: feature.id,
        domain: group.domain,
        evidence_ref: evidenceRef,
        typescript_tests: inventory.evidence[evidenceRef].typescript.tests,
      };
    }),
  ),
};
if (document.feature_coverage.length !== inventory.catalog_unique_feature_count) {
  throw new Error('Crosswalk feature coverage does not match the parent feature inventory.');
}
const rendered = await formatGenerated(`${JSON.stringify(document, null, 2)}\n`, outputPath);

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== rendered) {
    throw new Error('docs/parity-test-crosswalk.json is stale. Run pnpm generate:parity:crosswalk.');
  }
  console.log(
    `Parity test crosswalk OK: ${entries.length} Python test modules, ${parentDomains.length} domains, ${document.feature_coverage.length} parent features.`,
  );
} else {
  await writeFile(outputPath, rendered, 'utf8');
  console.log(
    `Wrote parity test crosswalk: ${entries.length} Python test modules, ${parentDomains.length} domains.`,
  );
}

async function validateParentCheckout(expectedTests) {
  const parentDir = resolve(requiredArgument('--parent'));
  const head = (
    await execFileAsync('git', ['-C', parentDir, 'rev-parse', 'HEAD'], { windowsHide: true })
  ).stdout.trim();
  if (head !== inventory.parent.commit) {
    throw new Error(`Parent checkout is ${head}; expected pinned commit ${inventory.parent.commit}.`);
  }
  const tracked = (
    await execFileAsync('git', ['-C', parentDir, 'ls-files', 'tests'], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })
  ).stdout
    .split(/\r?\n/)
    .filter((path) => /^tests\/.*test_.*\.py$/.test(path))
    .sort();
  if (JSON.stringify(tracked) !== JSON.stringify(expectedTests)) {
    throw new Error('Parent test modules differ from docs/parent-baseline.json.');
  }
}

function classify(path) {
  if (path.startsWith('tests/golden/')) return 'sdk_protocol_fixture';
  if (path.startsWith('tests/journey/') || path.includes('/smoke/')) return 'integration_smoke';
  if (/capabilit|unsupported|validation|security|error|approval|policy/.test(path)) {
    return 'partial_contract_negative';
  }
  return 'semantic';
}

function inferMapping(path) {
  const rules = [
    // Codex app-server provider modules (tests/runtime, tests/golden/codex, tests/integration/codex)
    // map onto the A8 contract-port suites, not the generic provider-runtime or journey fallthrough.
    [/codex/, ['Agent Sessions'], ['tests/unit/codex-agent-provider.test.ts', 'tests/golden/codex-app-server-events.test.ts']],
    // Package permission modules map onto the grant core (A5), the spine (A6), and the
    // mcp/workspaces/workspace-agents admission suites (A7); they must win over the
    // `workspace_agents`, `capabilit`, and `runtime` rules below.
    [/permission/, ['Skills and Workspace Agents', 'Local Tools', 'MCP'], ['tests/unit/tool-permissions.test.ts', 'tests/unit/permission-spine.test.ts', 'tests/unit/workspace-agent-runtime.test.ts', 'tests/unit/mcp.test.ts', 'tests/unit/workspaces.test.ts']],
    [/golden\/(openai|anthropic|gemini)/, ['Native Model Providers'], ['tests/golden/python-provider-differential.test.ts', 'tests/golden/providers.test.ts']],
    [/model_catalog|bundled_model|pricing|accounting/, ['Provider Controls and Catalog', 'Accounting and Cache'], ['tests/golden/python-catalog-differential.test.ts', 'tests/unit/registry-catalog.test.ts', 'tests/unit/planning-accounting-config.test.ts']],
    [/workspace_agents/, ['Skills and Workspace Agents', 'Package and Worker Hardening'], ['tests/unit/workspace-agents.test.ts']],
    [/workspaces|workspace_provider/, ['Workspaces', 'Workspace Providers and Security'], ['tests/unit/workspaces.test.ts', 'tests/security/boundaries.test.ts']],
    [/mcp/, ['MCP', 'MCP Lifecycle Security'], ['tests/unit/mcp.test.ts', 'tests/security/boundaries.test.ts']],
    [/realtime/, ['Realtime'], ['tests/unit/realtime.test.ts']],
    [/session|agents\//, ['Agent Sessions'], ['tests/unit/agent-sessions.test.ts']],
    [/worker|work_source/, ['Environment Workers'], ['tests/unit/workers-observability.test.ts']],
    [/observability|trace|sink/, ['Observability'], ['tests/unit/workers-observability.test.ts', 'tests/unit/persistence-observability.test.ts']],
    [/store|persist|resume|serializ/, ['Persistence', 'Persistence Contracts'], ['tests/unit/persistence-observability.test.ts', 'tests/golden/core-contracts.test.ts']],
    [/artifact/, ['Artifacts'], ['tests/unit/core-contracts.test.ts']],
    [/prompt/, ['Prompt Planning'], ['tests/unit/planning-accounting-config.test.ts']],
    [/config|workflow_profile/, ['Runtime Configuration'], ['tests/unit/planning-accounting-config.test.ts']],
    [/output|schema/, ['Structured Output'], ['tests/unit/tools-output.test.ts', 'tests/unit/agent-loop.test.ts']],
    [/hosted/, ['Hosted Tools'], ['tests/golden/providers.test.ts', 'tests/unit/agent-loop.test.ts']],
    [/tool/, ['Local Tools'], ['tests/unit/tools-output.test.ts', 'tests/unit/agent-loop.test.ts']],
    [/capabilit/, ['Granular Model Capabilities'], ['tests/unit/capabilities.test.ts', 'tests/unit/provider-contracts.test.ts']],
    [/provider|model_adapter/, ['Provider Runtime'], ['tests/unit/provider-contracts.test.ts', 'tests/unit/model-runtime.test.ts']],
    [/approval|policy|guardrail|safety/, ['Policy, Approvals, and Safety'], ['tests/unit/core-contracts.test.ts', 'tests/unit/agent-loop.test.ts']],
    [/core/, ['Core Events and State'], ['tests/golden/core-contracts.test.ts', 'tests/unit/core-contracts.test.ts']],
    [/runtime/, ['High-Level Runtime', 'Runtime Lifecycle Hardening'], ['tests/unit/agent-loop.test.ts', 'tests/journey/runtime-journey.test.ts']],
  ];
  for (const [pattern, domains, tests] of rules) {
    if (pattern.test(path)) return { domains, tests };
  }
  return {
    domains: ['High-Level Runtime'],
    tests: ['tests/journey/runtime-journey.test.ts'],
  };
}

function domainForEvidence(ref) {
  return inventory.groups.find(
    (group) =>
      group.classification === 'parent' &&
      (group.id === ref || group.features.some((feature) => feature.evidence.includes(ref))),
  )?.domain;
}

function slug(value) {
  return value
    .replace(/^tests\//, '')
    .replace(/\.py$/, '')
    .replace(/[^a-z0-9]+/gi, '.')
    .replace(/^\.|\.$/g, '')
    .toLowerCase();
}

function unique(value, index, values) {
  return value !== undefined && values.indexOf(value) === index;
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} <path> is required.`);
  return value;
}
