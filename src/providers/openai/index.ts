import { textCompletionCapabilityProfile } from '../../core/capabilities.js';
import { OpenAICompatibleChatProvider, type OpenAICompatibleProviderConfig } from '../openai-compatible/index.js';

export interface OpenAIProviderConfig
  extends Omit<OpenAICompatibleProviderConfig, 'providerId' | 'apiBase' | 'defaultHeaders'> {
  readonly apiBase?: string;
}

export class OpenAIProvider extends OpenAICompatibleChatProvider {
  constructor(config: OpenAIProviderConfig) {
    super({
      ...config,
      providerId: 'openai',
      apiBase: config.apiBase ?? 'https://api.openai.com/v1',
      capabilities: config.capabilities ?? ((model) => textCompletionCapabilityProfile('openai', model)),
    });
  }
}

export function createOpenAIProvider(config: OpenAIProviderConfig): OpenAIProvider {
  return new OpenAIProvider(config);
}
