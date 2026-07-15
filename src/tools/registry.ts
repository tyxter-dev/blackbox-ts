import { ToolExecutionError } from '../core/errors.js';
import type { ProviderToolDefinition, ToolDefinition } from './types.js';

export class ToolRegistry {
  protected readonly tools = new Map<string, ToolDefinition>();

  constructor(seed: readonly ToolDefinition[] = []) {
    for (const tool of seed) this.register(tool);
  }

  register(tool: ToolDefinition): ToolDefinition {
    if (!tool.name.trim()) throw new ToolExecutionError('Tool name cannot be empty.');
    if (this.tools.has(tool.name)) {
      throw new ToolExecutionError(`Tool '${tool.name}' is already registered.`, {
        code: 'duplicate_tool',
      });
    }
    this.tools.set(tool.name, tool);
    return tool;
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolExecutionError(`Unknown tool '${name}'.`, { code: 'tool_not_found' });
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  allTools(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  toProviderTools(names?: readonly string[]): readonly ProviderToolDefinition[] {
    const selected = names === undefined ? this.allTools() : names.map((name) => this.get(name));
    return selected.map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema,
    }));
  }

  session(): ToolSession {
    return new ToolSession(this.allTools());
  }
}

export class ToolSession extends ToolRegistry {}
