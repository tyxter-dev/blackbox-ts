import { createHash } from 'node:crypto';
import type { AgentRunRequest } from '../runtime/agent-loop.js';

export interface PromptFragment {
  readonly id: string;
  readonly content: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly cache_section?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PromptPlan {
  readonly instructions: string;
  readonly selected: readonly PromptFragment[];
  readonly skipped: readonly PromptFragment[];
  readonly cache_sections: Readonly<Record<string, string>>;
  readonly fingerprint: string;
}

export interface ResolvedRunSpec<T = string> {
  readonly request: AgentRunRequest<T>;
  readonly prompt: PromptPlan;
  readonly parity: { readonly matches: boolean; readonly fields: readonly string[] };
}

export function composePrompt(
  instructions: string | undefined,
  fragments: readonly PromptFragment[] = [],
): PromptPlan {
  const selected = fragments
    .filter((fragment) => fragment.enabled !== false)
    .sort(
      (left, right) =>
        (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id),
    );
  const skipped = fragments.filter((fragment) => fragment.enabled === false);
  const parts = [
    instructions?.trim(),
    ...selected.map((fragment) => fragment.content.trim()),
  ].filter((value): value is string => Boolean(value));
  const composed = parts.join('\n\n');
  const cacheSections: Record<string, string> = {};
  for (const fragment of selected) {
    if (fragment.cache_section !== undefined) {
      cacheSections[fragment.cache_section] = [
        cacheSections[fragment.cache_section],
        fragment.content,
      ]
        .filter(Boolean)
        .join('\n\n');
    }
  }
  return {
    instructions: composed,
    selected,
    skipped,
    cache_sections: cacheSections,
    fingerprint: createHash('sha256').update(composed).digest('hex'),
  };
}

export class PromptRuntime {
  dryRun<T>(
    request: AgentRunRequest<T>,
    fragments: readonly PromptFragment[] = request.prompt_fragments ?? [],
  ): ResolvedRunSpec<T> {
    const prompt = composePrompt(request.instructions, fragments);
    const resolved = { ...request, instructions: prompt.instructions };
    const fields = ['model', 'provider', 'instructions', 'tools', 'output', 'controls'];
    return { request: resolved, prompt, parity: { matches: true, fields } };
  }
}
