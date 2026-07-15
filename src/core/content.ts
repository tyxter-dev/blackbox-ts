import { UnsupportedFeatureError } from './errors.js';
import type { MediaRef } from './media.js';

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type ContentModality = 'text' | 'audio' | 'image' | 'video' | 'file';

export interface AgentTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface AgentAudioPart {
  readonly type: 'audio';
  readonly media: MediaRef;
  readonly transcript?: string;
}

export interface AgentImagePart {
  readonly type: 'image';
  readonly media: MediaRef;
  readonly detail?: 'auto' | 'low' | 'high';
}

export interface AgentVideoFramePart {
  readonly type: 'video_frame';
  readonly media: MediaRef;
  readonly timestamp_ms?: number;
}

export interface AgentFilePart {
  readonly type: 'file';
  readonly media: MediaRef;
  readonly filename?: string;
}

export interface AgentToolResultPart {
  readonly type: 'tool_result';
  readonly tool_call_id: string;
  readonly output: unknown;
  readonly is_error?: boolean;
}

export interface AgentProviderNativePart {
  readonly type: 'provider_native';
  readonly provider: string;
  readonly value: unknown;
}

export interface AgentRawPart {
  readonly type: 'raw';
  readonly value: unknown;
}

/** Compatibility content part retained from the first TypeScript release. */
export interface AgentJsonPart {
  readonly type: 'json';
  readonly value: unknown;
}

/** @deprecated Prefer a file part containing a MediaRef. */
export interface AgentFileRefPart {
  readonly type: 'file_ref';
  readonly file_id: string;
  readonly media_type?: string;
}

export type ContentPart =
  | AgentTextPart
  | AgentAudioPart
  | AgentImagePart
  | AgentVideoFramePart
  | AgentFilePart
  | AgentToolResultPart
  | AgentProviderNativePart
  | AgentRawPart;

export type AgentContentPart = ContentPart | AgentJsonPart | AgentFileRefPart;

export interface ContentItem {
  readonly role: AgentMessageRole;
  readonly parts: readonly ContentPart[];
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly created_at?: string;
}

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
      if (part.type === 'tool_result') {
        return typeof part.output === 'string' ? part.output : JSON.stringify(part.output);
      }
      if (part.type === 'audio' && part.transcript !== undefined) return part.transcript;

      throw new UnsupportedFeatureError(
        'content.text_projection',
        `Cannot project '${part.type}' content to text without losing information.`,
      );
    })
    .filter(Boolean)
    .join('\n');
}

export function textMessage(role: AgentMessageRole, text: string): AgentMessage {
  return { role, content: text };
}

export function textContentItem(role: AgentMessageRole, text: string): ContentItem {
  return { role, parts: [{ type: 'text', text }] };
}
