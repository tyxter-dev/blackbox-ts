import { AgentRuntimeError } from '../core/errors.js';
import type { ProviderModel, ProviderModelStatus } from './base.js';

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

export const BUNDLED_PROVIDER_MODEL_CATALOG_VERSION = '2026-09-05';
export const BUNDLED_PROVIDER_MODEL_RETRIEVED_AT = '2026-09-05';

const BUNDLED_PROVIDER_MODEL_SOURCE = 'blackbox-bundled';
/**
 * Retrieval date for rows the 2026-09-05 refresh did not revisit. Rows touched
 * by the refresh carry `BUNDLED_PROVIDER_MODEL_RETRIEVED_AT` instead.
 */
const PRIOR_RETRIEVED_AT = '2026-05-06';

const OPENAI_MODELS_URL = 'https://developers.openai.com/api/docs/models';
const ANTHROPIC_MODELS_URL = 'https://platform.claude.com/docs/en/models/overview';
const ANTHROPIC_DEPRECATIONS_URL =
  'https://platform.claude.com/docs/en/about-claude/model-deprecations';
const GEMINI_MODELS_URL = 'https://ai.google.dev/gemini-api/docs/models';
const XAI_MODELS_URL = 'https://docs.x.ai/developers/models';
const XAI_DEPRECATION_URL = 'https://docs.x.ai/developers/migration/may-15-retirement';

const TEXT_IMAGE_TOOLS = ['text', 'image', 'tools'] as const;
const GEMINI_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf', 'tools'] as const;

interface ModelRow {
  readonly provider: string;
  readonly id: string;
  readonly source_url: string;
  readonly display_name?: string;
  readonly family?: string;
  readonly aliases?: readonly string[];
  readonly status?: ProviderModelStatus;
  readonly replacement_model?: string;
  readonly modalities?: readonly string[];
  readonly context_window?: number;
  readonly max_output_tokens?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly retrieved_at?: string;
}

function model(row: ModelRow): ProviderModel {
  return {
    provider: row.provider,
    id: row.id,
    display_name: row.display_name,
    family: row.family,
    aliases: row.aliases ?? [],
    status: row.status ?? 'active',
    replacement_model: row.replacement_model,
    modalities: row.modalities ?? ['text'],
    context_window: row.context_window,
    max_output_tokens: row.max_output_tokens,
    source: BUNDLED_PROVIDER_MODEL_SOURCE,
    catalog_version: BUNDLED_PROVIDER_MODEL_CATALOG_VERSION,
    retrieved_at: row.retrieved_at ?? PRIOR_RETRIEVED_AT,
    source_url: row.source_url,
    metadata: row.metadata ?? {},
  };
}

export function bundledProviderModels(): readonly ProviderModel[] {
  return [...openaiModels(), ...anthropicModels(), ...geminiModels(), ...xaiModels()];
}

export function bundledProviderModelCatalog(
  extraModels: readonly ProviderModel[] = [],
): ProviderModelCatalog {
  return new ProviderModelCatalog([...bundledProviderModels(), ...extraModels]);
}

function openaiModels(): readonly ProviderModel[] {
  const reasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh'];
  const currentEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const current: readonly (readonly [string, string, string, string, readonly string[]])[] = [
    [
      'gpt-6-astra',
      'GPT-6 Astra',
      'gpt-6',
      '2026-04-30',
      ['low', 'medium', 'high', 'xhigh', 'max'],
    ],
    ['gpt-5.6-sol', 'GPT-5.6 Sol', 'gpt-5.6', '2026-02-16', currentEfforts],
    ['gpt-5.6-terra', 'GPT-5.6 Terra', 'gpt-5.6', '2026-02-16', currentEfforts],
    ['gpt-5.6-luna', 'GPT-5.6 Luna', 'gpt-5.6', '2026-02-16', currentEfforts],
  ];
  return [
    ...current.map(([id, displayName, family, cutoff, efforts]) =>
      model({
        provider: 'openai',
        id,
        display_name: displayName,
        family,
        aliases: id === 'gpt-5.6-sol' ? ['gpt-5.6'] : [],
        modalities: TEXT_IMAGE_TOOLS,
        context_window: 1_050_000,
        max_output_tokens: 128_000,
        source_url: `${OPENAI_MODELS_URL}/${id}`,
        retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
        metadata: {
          knowledge_cutoff: cutoff,
          max_input_tokens: 922_000,
          reasoning_efforts: efforts,
          ...(id === 'gpt-6-astra' ? { availability: 'account_access_dependent' } : {}),
        },
      }),
    ),
    model({
      provider: 'openai',
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      family: 'gpt-5',
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      source_url: OPENAI_MODELS_URL,
      metadata: { reasoning_efforts: reasoningEfforts, knowledge_cutoff: '2025-12-01' },
    }),
    model({
      provider: 'openai',
      id: 'gpt-5.4',
      display_name: 'GPT-5.4',
      family: 'gpt-5',
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 1_050_000,
      max_output_tokens: 128_000,
      source_url: OPENAI_MODELS_URL,
      metadata: { reasoning_efforts: reasoningEfforts, knowledge_cutoff: '2025-08-31' },
    }),
    model({
      provider: 'openai',
      id: 'gpt-5.4-mini',
      display_name: 'GPT-5.4 mini',
      family: 'gpt-5',
      aliases: ['gpt-5.4-mini-2026-03-17'],
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 400_000,
      max_output_tokens: 128_000,
      source_url: OPENAI_MODELS_URL,
      metadata: { reasoning_efforts: reasoningEfforts, knowledge_cutoff: '2025-08-31' },
    }),
  ];
}

function anthropicModels(): readonly ProviderModel[] {
  const current: readonly (readonly [string, string, string, Readonly<Record<string, unknown>>])[] =
    [
      [
        'claude-fable-5-1',
        'Claude Fable 5.1',
        'claude-fable',
        {
          knowledge_cutoff: '2026-06',
          training_cutoff: '2026-06',
          released_at: '2026-09-01',
          thinking_always_on: true,
        },
      ],
      [
        'claude-fable-5',
        'Claude Fable 5',
        'claude-fable',
        { thinking_always_on: true, knowledge_cutoff: '2026-01', released_at: '2026-06-09' },
      ],
      [
        'claude-opus-5',
        'Claude Opus 5',
        'claude-opus',
        { knowledge_cutoff: '2026-05', released_at: '2026-07-24' },
      ],
      [
        'claude-sonnet-5',
        'Claude Sonnet 5',
        'claude-sonnet',
        {
          knowledge_cutoff: '2026-01',
          training_cutoff: '2026-01',
          released_at: '2026-06-30',
        },
      ],
      [
        'claude-opus-4-8',
        'Claude Opus 4.8',
        'claude-opus',
        {
          knowledge_cutoff: '2026-01',
          released_at: '2026-05-28',
          thinking_default: 'disabled',
        },
      ],
    ];
  return [
    ...current.map(([id, displayName, family, details]) =>
      model({
        provider: 'anthropic',
        id,
        display_name: displayName,
        family,
        modalities: TEXT_IMAGE_TOOLS,
        context_window: 1_000_000,
        max_output_tokens: 128_000,
        source_url:
          id === 'claude-opus-4-8'
            ? 'https://platform.claude.com/docs/de/models/opus-4-8/overview'
            : `https://platform.claude.com/docs/en/models/${id.replace(/^claude-/, '')}/overview`,
        retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
        metadata: {
          reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          thinking: 'adaptive',
          ...details,
        },
      }),
    ),
    model({
      provider: 'anthropic',
      id: 'claude-opus-4-7',
      display_name: 'Claude Opus 4.7',
      family: 'claude-opus',
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      source_url: ANTHROPIC_MODELS_URL,
      metadata: { training_cutoff: '2026-01' },
    }),
    model({
      provider: 'anthropic',
      id: 'claude-sonnet-4-6',
      display_name: 'Claude Sonnet 4.6',
      family: 'claude-sonnet',
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 1_000_000,
      max_output_tokens: 64_000,
      source_url: ANTHROPIC_MODELS_URL,
      metadata: { training_cutoff: '2026-01' },
    }),
    model({
      provider: 'anthropic',
      id: 'claude-haiku-4-5-20251001',
      display_name: 'Claude Haiku 4.5',
      family: 'claude-haiku',
      aliases: ['claude-haiku-4-5'],
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 200_000,
      max_output_tokens: 64_000,
      source_url: ANTHROPIC_MODELS_URL,
      metadata: { training_cutoff: '2025-07' },
    }),
    ...anthropicLegacyModels(),
  ];
}

function anthropicLegacyModels(): readonly ProviderModel[] {
  return [
    model({
      provider: 'anthropic',
      id: 'claude-opus-4-1',
      display_name: 'Claude Opus 4.1',
      family: 'claude-opus',
      aliases: ['claude-opus-4-1-20250805'],
      status: 'retired',
      replacement_model: 'claude-opus-4-8',
      source_url: ANTHROPIC_DEPRECATIONS_URL,
      retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
      metadata: { retired_at: '2026-08-05' },
    }),
    model({
      provider: 'anthropic',
      id: 'claude-opus-4',
      display_name: 'Claude Opus 4',
      family: 'claude-opus',
      aliases: ['claude-opus-4-20250514'],
      status: 'retired',
      replacement_model: 'claude-opus-4-8',
      source_url: ANTHROPIC_DEPRECATIONS_URL,
      retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
      metadata: { retired_at: '2026-06-15' },
    }),
    model({
      provider: 'anthropic',
      id: 'claude-sonnet-4-5',
      display_name: 'Claude Sonnet 4.5',
      family: 'claude-sonnet',
      aliases: ['claude-sonnet-4-5-20250929'],
      status: 'active',
      retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
      context_window: 200_000,
      max_output_tokens: 64_000,
      source_url: ANTHROPIC_MODELS_URL,
      metadata: { context_window_beta: 1_000_000 },
    }),
    model({
      provider: 'anthropic',
      id: 'claude-sonnet-4',
      display_name: 'Claude Sonnet 4',
      family: 'claude-sonnet',
      aliases: ['claude-sonnet-4-20250514'],
      status: 'retired',
      replacement_model: 'claude-sonnet-4-6',
      source_url: ANTHROPIC_DEPRECATIONS_URL,
      retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
      metadata: { retired_at: '2026-06-15' },
    }),
    model({
      provider: 'anthropic',
      id: 'claude-haiku-3-5',
      display_name: 'Claude Haiku 3.5',
      family: 'claude-haiku',
      aliases: ['claude-3-5-haiku-20241022'],
      status: 'retired',
      replacement_model: 'claude-haiku-4-5',
      source_url: ANTHROPIC_DEPRECATIONS_URL,
      retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
      metadata: { retired_at: '2026-02-19' },
    }),
  ];
}

function geminiModels(): readonly ProviderModel[] {
  return [
    model({
      provider: 'google',
      id: 'gemini-3-flash-preview',
      display_name: 'Gemini 3 Flash Preview',
      family: 'gemini-3',
      status: 'preview',
      modalities: GEMINI_MODALITIES,
      source_url: GEMINI_MODELS_URL,
    }),
    ...(
      [
        ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
        ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
        ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite'],
      ] as const
    ).map(([id, displayName]) =>
      model({
        provider: 'google',
        id,
        display_name: displayName,
        family: 'gemini-2.5',
        modalities: GEMINI_MODALITIES,
        context_window: 1_048_576,
        max_output_tokens: 65_536,
        source_url: GEMINI_MODELS_URL,
      }),
    ),
  ];
}

function xaiModels(): readonly ProviderModel[] {
  const retirementMetadata = {
    deprecates_at: '2026-05-15T12:00:00-07:00',
    deprecation_url: XAI_DEPRECATION_URL,
    retired_at: '2026-05-15',
    redirect_model: 'grok-4.3',
  };
  return [
    model({
      provider: 'xai',
      id: 'grok-4.6',
      display_name: 'Grok 4.6',
      family: 'grok-4',
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 500_000,
      source_url: `${XAI_MODELS_URL}/grok-4.6`,
      retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
      metadata: { reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
    }),
    model({
      provider: 'xai',
      id: 'grok-4.3',
      display_name: 'Grok 4.3',
      family: 'grok-4',
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 1_000_000,
      source_url: `${XAI_MODELS_URL}/grok-4.3`,
      retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
    }),
    model({
      provider: 'xai',
      id: 'grok-4.20-0309-non-reasoning',
      display_name: 'Grok 4.20 non-reasoning',
      family: 'grok-4',
      aliases: ['grok-4.20-non-reasoning'],
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 2_000_000,
      source_url: XAI_MODELS_URL,
    }),
    model({
      provider: 'xai',
      id: 'grok-4-1-fast-reasoning',
      display_name: 'Grok 4.1 Fast Reasoning',
      family: 'grok-4',
      status: 'retired',
      replacement_model: 'grok-4.3',
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 2_000_000,
      source_url: XAI_DEPRECATION_URL,
      retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
      metadata: { ...retirementMetadata, redirect_reasoning_effort: 'low' },
    }),
    model({
      provider: 'xai',
      id: 'grok-4-1-fast-non-reasoning',
      display_name: 'Grok 4.1 Fast Non-Reasoning',
      family: 'grok-4',
      status: 'retired',
      replacement_model: 'grok-4.3',
      modalities: TEXT_IMAGE_TOOLS,
      context_window: 2_000_000,
      source_url: XAI_DEPRECATION_URL,
      retrieved_at: BUNDLED_PROVIDER_MODEL_RETRIEVED_AT,
      metadata: { ...retirementMetadata, redirect_reasoning_effort: 'none' },
    }),
  ];
}
