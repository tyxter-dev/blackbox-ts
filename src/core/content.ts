export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface AgentJsonPart {
  readonly type: 'json';
  readonly value: unknown;
}

export interface AgentFileRefPart {
  readonly type: 'file_ref';
  readonly file_id: string;
  readonly media_type?: string;
}

export type AgentContentPart = AgentTextPart | AgentJsonPart | AgentFileRefPart;

export interface AgentMessage {
  readonly role: AgentMessageRole;
  readonly content: string | readonly AgentContentPart[];
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly created_at?: string;
}

export function contentToText(content: string | readonly AgentContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'json') return JSON.stringify(part.value);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function textMessage(role: AgentMessageRole, text: string): AgentMessage {
  return { role, content: text };
}
