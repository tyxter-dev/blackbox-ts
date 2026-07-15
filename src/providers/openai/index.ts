export {
  OpenAIResponsesProvider,
  openAIResponsesCapabilityProfile,
  type OpenAIResponsesProviderConfig,
} from './responses-provider.js';

import {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderConfig,
} from './responses-provider.js';

export type OpenAIProviderConfig = OpenAIResponsesProviderConfig;

export class OpenAIProvider extends OpenAIResponsesProvider {}

export function createOpenAIProvider(config: OpenAIProviderConfig): OpenAIProvider {
  return new OpenAIProvider(config);
}
