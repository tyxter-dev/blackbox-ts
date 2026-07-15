import { capability, type CapabilityProfile } from '../../core/capabilities.js';
import {
  OpenAIResponsesProvider,
  openAIResponsesCapabilityProfile,
  type OpenAIResponsesProviderConfig,
} from '../openai/responses-provider.js';

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
  return {
    ...profile,
    summary: {
      ...profile.summary,
      supports_hosted_tools: false,
      supports_mcp: false,
    },
    hosted_tools: unsupportedHosted,
    integrations: {
      ...profile.integrations,
      mcp: capability('unsupported'),
    },
    source: 'blackbox-ts:xai-responses',
  };
}
