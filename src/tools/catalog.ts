import type { ToolDefinition } from './types.js';
import { ToolExecutionError } from '../core/errors.js';
import {
  activePermissions,
  definitionAllowed,
  markInternalDiscoveryTool,
} from '../core/tool-permissions.js';
import { toolResult } from './types.js';

export interface ToolSearchResult {
  readonly tool: ToolDefinition;
  readonly score: number;
}

export class ToolCatalog {
  constructor(private readonly tools: readonly ToolDefinition[] = []) {}

  search(query: string, limit = 10): readonly ToolSearchResult[] {
    const terms = tokenize(query);
    return this.tools
      .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
      .filter((result) => result.score > 0)
      .sort(
        (left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name),
      )
      .slice(0, limit);
  }
}

export interface ToolBudget {
  readonly max_visible?: number;
  readonly max_calls?: number;
  readonly max_parallel?: number;
  readonly max_schema_bytes?: number;
}

export interface Toolset {
  readonly name: string;
  readonly tools: readonly ToolDefinition[];
  readonly budget?: ToolBudget;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ToolSelectionMode = 'static' | 'dynamic';

export class ToolsetRuntime {
  private readonly catalog: ToolCatalog;
  private readonly toolsByName = new Map<string, ToolDefinition>();
  private readonly visible = new Set<string>();
  private calls = 0;

  readonly searchToolName = 'search_tools';
  readonly loadToolName = 'load_tools';

  constructor(
    toolsets: readonly Toolset[],
    readonly selection: ToolSelectionMode = 'static',
    readonly budget: ToolBudget = {},
  ) {
    for (const toolset of toolsets) {
      for (const tool of toolset.tools) {
        if (this.toolsByName.has(tool.name)) {
          throw new ToolExecutionError(`Tool '${tool.name}' appears in more than one toolset.`, {
            code: 'duplicate_toolset_tool',
          });
        }
        this.toolsByName.set(tool.name, tool);
      }
    }
    this.catalog = new ToolCatalog([...this.toolsByName.values()]);
    if (selection === 'static') this.load([...this.toolsByName.keys()]);
  }

  /**
   * Every tool the toolsets contributed, including tools the active package
   * boundary denies.
   *
   * This is the registration feed, not an exposure surface: a denied tool must
   * still reach the tool registry so a model that names it anyway is refused
   * at dispatch with `denied_by_policy` instead of `tool_not_found`. The
   * exposure surfaces -- {@link visibleDefinitions}, {@link visibleNames},
   * {@link search} and {@link load} -- are the filtered ones.
   */
  allDefinitions(): readonly ToolDefinition[] {
    return [...this.toolsByName.values()];
  }

  visibleDefinitions(): readonly ToolDefinition[] {
    return [...this.visible]
      .map((name) => this.toolsByName.get(name)!)
      .filter(Boolean)
      .filter((tool) => this.exposable(tool));
  }

  visibleNames(): readonly string[] {
    if (activePermissions().length === 0) return [...this.visible];
    return this.visibleDefinitions().map((tool) => tool.name);
  }

  metaTools(): readonly ToolDefinition[] {
    if (this.selection !== 'dynamic') return [];
    return [
      {
        name: this.searchToolName,
        description: 'Search the available tool catalog.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'integer' } },
          required: ['query'],
          additionalProperties: false,
        },
        // Marked by identity: discovery stays reachable inside a package
        // permission boundary, while a registered tool that only borrows the
        // reserved name is still enforced.
        handler: markInternalDiscoveryTool(({ query, limit }) => {
          const normalizedQuery = typeof query === 'string' ? query : '';
          const results = this.search(normalizedQuery, typeof limit === 'number' ? limit : 10);
          return toolResult(JSON.stringify(results), { payload: { results } });
        }),
      },
      {
        name: this.loadToolName,
        description: 'Load named tools into the model-visible tool surface.',
        input_schema: {
          type: 'object',
          properties: { names: { type: 'array', items: { type: 'string' } } },
          required: ['names'],
          additionalProperties: false,
        },
        handler: markInternalDiscoveryTool(({ names }) => {
          const requested = Array.isArray(names)
            ? names.filter((name): name is string => typeof name === 'string')
            : [];
          const denied = this.load(requested);
          const loaded = requested.filter((name) => !denied.includes(name));
          return toolResult(`Loaded ${loaded.join(', ') || 'no tools'}.`, {
            payload: {
              visible_tools: this.visibleNames(),
              ...(denied.length === 0 ? {} : { denied, reason: 'denied_by_package' }),
            },
          });
        }),
      },
    ];
  }

  search(query: string, limit = 10): readonly Readonly<Record<string, unknown>>[] {
    // Rebuild the catalog per search inside a boundary: a denied tool must be
    // invisible to discovery, and the decision can differ between two searches
    // of the same runtime when the boundaries differ.
    const catalog =
      activePermissions().length === 0
        ? this.catalog
        : new ToolCatalog(this.allDefinitions().filter((tool) => this.exposable(tool)));
    return catalog.search(query, limit).map(({ tool, score }) => ({
      name: tool.name,
      description: tool.description,
      score,
      category: tool.category,
      risk: tool.risk,
    }));
  }

  /**
   * Make the named tools model-visible and return the names the active package
   * boundary refused.
   *
   * A refused name is skipped rather than thrown on, mirroring the parent's
   * `load_tools`, which keeps loading the rest and returns the refused ones to
   * the model in its `invalid` list. The parent additionally emits a
   * run-visible TOOL_CHOICE_REJECTED event carrying `denied_by_package`; this
   * port has no per-load event channel, so the `denied` / `denied_by_package`
   * fields on the `load_tools` payload are its model-visible equivalent.
   */
  load(names: readonly string[]): readonly string[] {
    const denied: string[] = [];
    for (const name of names) {
      if (!this.toolsByName.has(name)) {
        throw new ToolExecutionError(`Cannot load unknown tool '${name}'.`, {
          code: 'tool_not_found',
        });
      }
      if (!this.exposable(this.toolsByName.get(name)!)) denied.push(name);
    }
    const admitted = denied.length === 0 ? names : names.filter((name) => !denied.includes(name));
    const next = new Set([...this.visible, ...admitted]);
    if (this.budget.max_visible !== undefined && next.size > this.budget.max_visible) {
      throw budgetError('visible', this.budget.max_visible);
    }
    const schemaBytes = [...next].reduce((total, name) => {
      const tool = this.toolsByName.get(name);
      return total + Buffer.byteLength(JSON.stringify(tool?.input_schema ?? {}), 'utf8');
    }, 0);
    if (this.budget.max_schema_bytes !== undefined && schemaBytes > this.budget.max_schema_bytes) {
      throw budgetError('schema bytes', this.budget.max_schema_bytes);
    }
    this.visible.clear();
    for (const name of next) this.visible.add(name);
    return denied;
  }

  private exposable(tool: ToolDefinition): boolean {
    return activePermissions().length === 0 || definitionAllowed(tool);
  }

  recordCalls(count: number): void {
    this.calls += count;
    if (this.budget.max_calls !== undefined && this.calls > this.budget.max_calls) {
      throw budgetError('calls', this.budget.max_calls);
    }
  }

  assertParallel(count: number): void {
    if (this.budget.max_parallel !== undefined && count > this.budget.max_parallel) {
      throw budgetError('parallel calls', this.budget.max_parallel);
    }
  }

  metadata(): Readonly<Record<string, unknown>> {
    return {
      selection: this.selection,
      visible_tools: this.visibleNames(),
      calls: this.calls,
      budget: this.budget,
    };
  }
}

function budgetError(kind: string, limit: number): ToolExecutionError {
  return new ToolExecutionError(`Tool ${kind} budget of ${limit} was exceeded.`, {
    code: 'tool_budget_exceeded',
  });
}

function scoreTool(tool: ToolDefinition, terms: readonly string[]): number {
  const name = tool.name.toLowerCase();
  const content = [tool.name, tool.description, tool.category, ...(tool.tags ?? [])]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return terms.reduce((score, term) => {
    if (name === term) return score + 10;
    if (name.includes(term)) return score + 5;
    return content.includes(term) ? score + 1 : score;
  }, 0);
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(Boolean);
}
