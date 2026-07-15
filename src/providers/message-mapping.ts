import type { AgentMessage } from '../core/content.js';
import { contentToText } from '../core/content.js';

export interface OpenAICompatibleMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string;
  readonly tool_call_id?: string;
}

export function inputToMessages(
  input: string | readonly AgentMessage[],
  instructions?: string,
): readonly OpenAICompatibleMessage[] {
  const messages: OpenAICompatibleMessage[] = [];
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }
  for (const message of input) {
    messages.push({
      role: message.role,
      content: contentToText(message.content),
      name: message.name,
      tool_call_id: message.tool_call_id,
    });
  }
  return messages;
}

export function splitSystemAndChatMessages(
  input: string | readonly AgentMessage[],
  instructions?: string,
): {
  readonly system: string | undefined;
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }>;
} {
  const systemParts: string[] = [];
  if (instructions) systemParts.push(instructions);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return { system: joinOptional(systemParts), messages };
  }

  for (const message of input) {
    const text = contentToText(message.content);
    if (message.role === 'system') {
      systemParts.push(text);
    } else if (message.role === 'assistant' || message.role === 'user') {
      messages.push({ role: message.role, content: text });
    }
  }

  return { system: joinOptional(systemParts), messages };
}

function joinOptional(parts: readonly string[]): string | undefined {
  const joined = parts.filter(Boolean).join('\n\n');
  return joined.length > 0 ? joined : undefined;
}
