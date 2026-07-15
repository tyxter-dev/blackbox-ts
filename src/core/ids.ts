export type RuntimeIdPrefix =
  | 'evt'
  | 'item'
  | 'sess'
  | 'art'
  | 'approval'
  | 'inv'
  | 'run'
  | 'agent'
  | 'ws';

export function createRuntimeId(prefix: RuntimeIdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}
