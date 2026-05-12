import { textCompletionCapabilityProfile } from '../../core/capabilities.js';
import { OpenAICompatibleChatProvider, type OpenAICompatibleProviderConfig } from '../openai-compatible/index.js';

export interface XAIProviderConfig
  extends Omit<OpenAICompatibleProviderConfig, 'providerId' | 'apiBase' | 'defaultHeaders'> {
  readonly apiBase?: string;
}

export class XAIProvider extends OpenAICompatibleChatProvider {
  constructor(config: XAIProviderConfig) {
    super({
      ...config,
      providerId: 'xai',
      apiBase: config.apiBase ?? 'https://api.x.ai/v1',
      capabilities: config.capabilities ?? ((model) => textCompletionCapabilityProfile('xai', model)),
    });
  }
}

export function createXAIProvider(config: XAIProviderConfig): XAIProvider {
  return new XAIProvider(config);
}
