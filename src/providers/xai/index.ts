import { capability, type CapabilityProfile } from '../../core/capabilities.js';
import type { TurnRequest } from '../base.js';
import {
  OpenAIResponsesProvider,
  openAIResponsesCapabilityProfile,
  validateModelEffort,
  type OpenAIResponsesProviderConfig,
} from '../openai/responses-provider.js';

/**
 * Reasoning-effort table for the xAI models that enforce one.
 *
 * Models outside this table keep the effort list advertised by the inherited
 * OpenAI Responses profile.
 */
const CURRENT_XAI_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  'grok-4.6': ['low', 'medium', 'high', 'xhigh'],
};

export interface XAIProviderConfig extends Omit<
  OpenAIResponsesProviderConfig,
  'providerId' | 'apiBase'
> {
  readonly apiBase?: string;
}

export class XAIResponsesProvider extends OpenAIResponsesProvider {
  constructor(config: XAIProviderConfig) {
    super({
      ...config,
      providerId: 'xai',
      apiBase: config.apiBase ?? 'https://api.x.ai/v1',
      capabilities: config.capabilities ?? xAIResponsesCapabilityProfile,
    });
  }

  override buildResponsesRequest(request: TurnRequest): {
    readonly url: string;
    readonly body: Readonly<Record<string, unknown>>;
    readonly headers: Readonly<Record<string, string>>;
  } {
    const built = super.buildResponsesRequest(request);
    validateModelEffort(this.id, built.body, CURRENT_XAI_EFFORTS);
    return built;
  }
}

export class XAIProvider extends XAIResponsesProvider {}

export function createXAIProvider(config: XAIProviderConfig): XAIProvider {
  return new XAIProvider(config);
}

export function xAIResponsesCapabilityProfile(model?: string): CapabilityProfile {
  const profile = openAIResponsesCapabilityProfile('xai', model);
  const unsupportedHosted = Object.fromEntries(
    Object.keys(profile.hosted_tools).map((name) => [
      name,
      name === 'raw'
        ? capability('passthrough')
        : capability('unsupported', {
            reason: 'xAI Responses does not advertise this OpenAI hosted-tool surface.',
          }),
    ]),
  );
  const efforts =
    model !== undefined && Object.hasOwn(CURRENT_XAI_EFFORTS, model)
      ? CURRENT_XAI_EFFORTS[model]
      : undefined;
  return {
    ...profile,
    summary: {
      ...profile.summary,
      supports_hosted_tools: false,
      supports_mcp: false,
    },
    hosted_tools: unsupportedHosted,
    controls:
      efforts === undefined
        ? profile.controls
        : {
            ...profile.controls,
            reasoning_effort: capability('supported', {
              native_name: 'reasoning.effort',
              supported_values: efforts,
            }),
          },
    integrations: {
      ...profile.integrations,
      mcp: capability('unsupported'),
    },
    source: 'blackbox-ts:xai-responses',
  };
}
