import { AgentRuntimeError } from '../core/errors.js';
import type { ProviderModel } from './base.js';

export class ProviderModelCatalog {
  private readonly modelsByKey = new Map<string, ProviderModel>();
  private readonly aliases = new Map<string, string>();

  constructor(models: readonly ProviderModel[] = []) {
    for (const model of models) {
      this.add(model);
    }
  }

  add(model: ProviderModel): void {
    const key = modelKey(model.provider, model.id);
    this.modelsByKey.set(key, model);
    for (const alias of model.aliases ?? []) {
      this.aliases.set(modelKey(model.provider, alias), key);
    }
  }

  get(provider: string, model: string): ProviderModel {
    const key = this.resolveKey(provider, model);
    const found = this.modelsByKey.get(key);
    if (!found) {
      throw new AgentRuntimeError(`Unknown model '${provider}:${model}'.`, {
        code: 'unknown_model',
      });
    }
    return found;
  }

  has(provider: string, model: string): boolean {
    return this.modelsByKey.has(this.resolveKey(provider, model));
  }

  list(provider?: string): readonly ProviderModel[] {
    const all = [...this.modelsByKey.values()];
    return provider ? all.filter((model) => model.provider === provider) : all;
  }

  resolve(provider: string, model: string): { readonly provider: string; readonly model: string } {
    const found = this.get(provider, model);
    return { provider: found.provider, model: found.id };
  }

  private resolveKey(provider: string, model: string): string {
    const key = modelKey(provider, model);
    return this.aliases.get(key) ?? key;
  }
}

export function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export const BUNDLED_PROVIDER_MODEL_CATALOG_VERSION = '2026-05-06';
export const BUNDLED_PROVIDER_MODEL_RETRIEVED_AT = '2026-05-06';

export function bundledProviderModels(): readonly ProviderModel[] {
  const common = {
    source: 'blackbox-bundled',
    catalog_version: BUNDLED_PROVIDER_MODEL_CATALOG_VERSION,
    retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
  } as const;
  const textImageTools = ['text', 'image', 'tools'] as const;
  const geminiModalities = ['text', 'image', 'audio', 'video', 'pdf', 'tools'] as const;

  return [
    {
      ...common,
      provider: 'openai',
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      family: 'gpt-5',
      status: 'active',
      modalities: textImageTools,
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      source_url: 'https://developers.openai.com/api/docs/models',
      metadata: {
        reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        knowledge_cutoff: '2025-12-01',
      },
    },
    {
      ...common,
      provider: 'openai',
      id: 'gpt-5.4',
      display_name: 'GPT-5.4',
      family: 'gpt-5',
      status: 'active',
      modalities: textImageTools,
      context_window: 1_050_000,
      max_output_tokens: 128_000,
      source_url: 'https://developers.openai.com/api/docs/models',
      metadata: {
        reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        knowledge_cutoff: '2025-08-31',
      },
    },
    {
      ...common,
      provider: 'openai',
      id: 'gpt-5.4-mini',
      display_name: 'GPT-5.4 mini',
      family: 'gpt-5',
      aliases: ['gpt-5.4-mini-2026-03-17'],
      status: 'active',
      modalities: textImageTools,
      context_window: 400_000,
      max_output_tokens: 128_000,
      source_url: 'https://developers.openai.com/api/docs/models',
      metadata: {
        reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        knowledge_cutoff: '2025-08-31',
      },
    },
    {
      ...common,
      provider: 'anthropic',
      id: 'claude-opus-4-7',
      display_name: 'Claude Opus 4.7',
      family: 'claude-opus',
      status: 'active',
      modalities: textImageTools,
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      source_url: 'https://platform.claude.com/docs/en/about-claude/models/overview',
      metadata: { training_cutoff: '2026-01' },
    },
    {
      ...common,
      provider: 'anthropic',
      id: 'claude-sonnet-4-6',
      display_name: 'Claude Sonnet 4.6',
      family: 'claude-sonnet',
      status: 'active',
      modalities: textImageTools,
      context_window: 1_000_000,
      max_output_tokens: 64_000,
      source_url: 'https://platform.claude.com/docs/en/about-claude/models/overview',
      metadata: { training_cutoff: '2026-01' },
    },
    {
      ...common,
      provider: 'anthropic',
      id: 'claude-haiku-4-5-20251001',
      display_name: 'Claude Haiku 4.5',
      family: 'claude-haiku',
      aliases: ['claude-haiku-4-5'],
      status: 'active',
      modalities: textImageTools,
      context_window: 200_000,
      max_output_tokens: 64_000,
      source_url: 'https://platform.claude.com/docs/en/about-claude/models/overview',
      metadata: { training_cutoff: '2025-07' },
    },
    ...anthropicLegacyModels(common),
    {
      ...common,
      provider: 'google',
      id: 'gemini-3-flash-preview',
      display_name: 'Gemini 3 Flash Preview',
      family: 'gemini-3',
      status: 'preview',
      modalities: geminiModalities,
      source_url: 'https://ai.google.dev/gemini-api/docs/models',
    },
    ...['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'].map(
      (id): ProviderModel => ({
        ...common,
        provider: 'google',
        id,
        display_name: modelDisplayName(id),
        family: 'gemini-2.5',
        status: 'active',
        modalities: geminiModalities,
        context_window: 1_048_576,
        max_output_tokens: 65_536,
        source_url: 'https://ai.google.dev/gemini-api/docs/models',
      }),
    ),
    {
      ...common,
      provider: 'xai',
      id: 'grok-4.3',
      display_name: 'Grok 4.3',
      family: 'grok-4',
      status: 'active',
      modalities: textImageTools,
      context_window: 1_000_000,
      source_url: 'https://docs.x.ai/developers/models',
    },
    {
      ...common,
      provider: 'xai',
      id: 'grok-4.20-0309-non-reasoning',
      display_name: 'Grok 4.20 non-reasoning',
      family: 'grok-4',
      aliases: ['grok-4.20-non-reasoning'],
      status: 'active',
      modalities: textImageTools,
      context_window: 2_000_000,
      source_url: 'https://docs.x.ai/developers/models',
    },
    ...xaiDeprecatingModels(common, textImageTools),
  ];
}

export function bundledProviderModelCatalog(
  extraModels: readonly ProviderModel[] = [],
): ProviderModelCatalog {
  return new ProviderModelCatalog([...bundledProviderModels(), ...extraModels]);
}

function anthropicLegacyModels(common: Readonly<Record<string, string>>): readonly ProviderModel[] {
  const sourceUrl = 'https://platform.claude.com/docs/en/about-claude/models/overview';
  return [
    legacyAnthropic('claude-opus-4-1', 'Claude Opus 4.1', 'claude-opus-4-7', common, sourceUrl, [
      'claude-opus-4-1-20250805',
    ]),
    legacyAnthropic('claude-opus-4', 'Claude Opus 4', 'claude-opus-4-7', common, sourceUrl, [
      'claude-opus-4-20250514',
    ]),
    {
      ...legacyAnthropic(
        'claude-sonnet-4-5',
        'Claude Sonnet 4.5',
        'claude-sonnet-4-6',
        common,
        sourceUrl,
        ['claude-sonnet-4-5-20250929'],
      ),
      context_window: 200_000,
      max_output_tokens: 64_000,
      metadata: { context_window_beta: 1_000_000 },
    },
    legacyAnthropic('claude-sonnet-4', 'Claude Sonnet 4', 'claude-sonnet-4-6', common, sourceUrl, [
      'claude-sonnet-4-20250514',
    ]),
    legacyAnthropic('claude-haiku-3-5', 'Claude Haiku 3.5', 'claude-haiku-4-5', common, sourceUrl, [
      'claude-3-5-haiku-20241022',
    ]),
  ];
}

function legacyAnthropic(
  id: string,
  displayName: string,
  replacement: string,
  common: Readonly<Record<string, string>>,
  sourceUrl: string,
  aliases: readonly string[],
): ProviderModel {
  return {
    ...common,
    provider: 'anthropic',
    id,
    display_name: displayName,
    family: id.includes('sonnet')
      ? 'claude-sonnet'
      : id.includes('haiku')
        ? 'claude-haiku'
        : 'claude-opus',
    aliases,
    status: 'unknown',
    replacement_model: replacement,
    modalities: ['text'],
    source_url: sourceUrl,
  };
}

function xaiDeprecatingModels(
  common: Readonly<Record<string, string>>,
  modalities: readonly string[],
): readonly ProviderModel[] {
  const metadata = {
    deprecates_at: '2026-05-15T12:00:00-07:00',
    deprecation_url: 'https://docs.x.ai/developers/migration/may-15-deprecation',
  };
  return [
    {
      ...common,
      provider: 'xai',
      id: 'grok-4-1-fast-reasoning',
      display_name: 'Grok 4.1 Fast Reasoning',
      family: 'grok-4',
      status: 'deprecating',
      replacement_model: 'grok-4.3',
      modalities,
      context_window: 2_000_000,
      source_url: 'https://docs.x.ai/developers/models',
      metadata,
    },
    {
      ...common,
      provider: 'xai',
      id: 'grok-4-1-fast-non-reasoning',
      display_name: 'Grok 4.1 Fast Non-Reasoning',
      family: 'grok-4',
      status: 'deprecating',
      replacement_model: 'grok-4.20-0309-non-reasoning',
      modalities,
      context_window: 2_000_000,
      source_url: 'https://docs.x.ai/developers/models',
      metadata,
    },
  ];
}

function modelDisplayName(id: string): string {
  const suffix = id.replace('gemini-2.5-', '');
  return `Gemini 2.5 ${suffix.charAt(0).toUpperCase()}${suffix.slice(1).replace('-', '-')}`;
}
