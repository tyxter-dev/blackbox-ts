import { textCompletionCapabilityProfile } from '../../core/capabilities.js';
import { OpenAICompatibleChatProvider, type OpenAICompatibleProviderConfig } from '../openai-compatible/index.js';

export interface OpenRouterProviderConfig
  extends Omit<OpenAICompatibleProviderConfig, 'providerId' | 'apiBase' | 'defaultHeaders'> {
  readonly apiBase?: string;
  readonly appUrl?: string;
  readonly appTitle?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}

export class OpenRouterProvider extends OpenAICompatibleChatProvider {
  constructor(config: OpenRouterProviderConfig) {
    super({
      ...config,
      providerId: 'openrouter',
      apiBase: config.apiBase ?? 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        ...(config.appUrl ? { 'HTTP-Referer': config.appUrl } : {}),
        ...(config.appTitle ? { 'X-Title': config.appTitle } : {}),
        ...(config.defaultHeaders ?? {}),
      },
      capabilities: config.capabilities ?? ((model) => textCompletionCapabilityProfile('openrouter', model)),
    });
  }
}

export function createOpenRouterProvider(config: OpenRouterProviderConfig): OpenRouterProvider {
  return new OpenRouterProvider(config);
}
