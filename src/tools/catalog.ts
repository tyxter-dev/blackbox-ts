import type { ToolDefinition } from './types.js';
import { ToolExecutionError } from '../core/errors.js';
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

  allDefinitions(): readonly ToolDefinition[] {
    return [...this.toolsByName.values()];
  }

  visibleDefinitions(): readonly ToolDefinition[] {
    return [...this.visible].map((name) => this.toolsByName.get(name)!).filter(Boolean);
  }

  visibleNames(): readonly string[] {
    return [...this.visible];
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
        handler: ({ query, limit }) => {
          const normalizedQuery = typeof query === 'string' ? query : '';
          const results = this.search(normalizedQuery, typeof limit === 'number' ? limit : 10);
          return toolResult(JSON.stringify(results), { payload: { results } });
        },
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
        handler: ({ names }) => {
          const requested = Array.isArray(names)
            ? names.filter((name): name is string => typeof name === 'string')
            : [];
          this.load(requested);
          return toolResult(`Loaded ${requested.join(', ') || 'no tools'}.`, {
            payload: { visible_tools: this.visibleNames() },
          });
        },
      },
    ];
  }

  search(query: string, limit = 10): readonly Readonly<Record<string, unknown>>[] {
    return this.catalog.search(query, limit).map(({ tool, score }) => ({
      name: tool.name,
      description: tool.description,
      score,
      category: tool.category,
      risk: tool.risk,
    }));
  }

  load(names: readonly string[]): void {
    for (const name of names) {
      if (!this.toolsByName.has(name)) {
        throw new ToolExecutionError(`Cannot load unknown tool '${name}'.`, {
          code: 'tool_not_found',
        });
      }
    }
    const next = new Set([...this.visible, ...names]);
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
