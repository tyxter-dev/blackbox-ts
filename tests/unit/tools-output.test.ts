import { describe, expect, it } from 'vitest';

import {
  OutputValidationError,
  ToolCatalog,
  ToolRegistry,
  ToolRuntime,
  outputSchema,
  toolResult,
  validateOutputText,
} from '../../src/index.js';

describe('local tools', () => {
  it('registers, exports schemas, injects private context, and separates payloads', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'lookup',
      description: 'Look up a record',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      context_parameters: ['tenant_id'],
      handler: ({ id, tenant_id }) =>
        toolResult(`found ${String(id)}`, { payload: { id, tenant_id } }),
    });
    const runtime = new ToolRuntime(registry, { context: { tenant_id: 'tenant_1' } });

    const result = await runtime.call('lookup', { id: '42' });
    expect(result).toMatchObject({
      content: 'found 42',
      payload: { id: '42', tenant_id: 'tenant_1' },
      is_error: false,
    });
    expect(registry.toProviderTools()).toEqual([
      {
        name: 'lookup',
        description: 'Look up a record',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    ]);
  });

  it('supports isolated sessions, catalog search, mocks, concurrency, and timeouts', async () => {
    const registry = new ToolRegistry([
      { name: 'weather_lookup', description: 'Weather by city', handler: () => 'sunny' },
    ]);
    const session = registry.session();
    session.register({ name: 'private_tool', handler: () => 'private' });
    const runtime = new ToolRuntime(session, { timeout_ms: 5 });

    expect(registry.has('private_tool')).toBe(false);
    expect(new ToolCatalog(session.allTools()).search('weather city')[0]?.tool.name).toBe(
      'weather_lookup',
    );
    await expect(runtime.call('weather_lookup', {}, { mock: true })).resolves.toMatchObject({
      metadata: { mock: true },
    });

    session.register({
      name: 'slow',
      handler: () => new Promise(() => undefined),
    });
    await expect(runtime.call('slow', {})).rejects.toMatchObject({ code: 'tool_timeout' });
  });

  it('routes blocking handlers through an injectable offload executor', async () => {
    const registry = new ToolRegistry([
      { name: 'blocking', blocking: true, handler: ({ value }) => String(value) },
    ]);
    const offloaded: string[] = [];
    const runtime = new ToolRuntime(registry, {
      blocking_executor: {
        execute: (definition, arguments_, context) => {
          offloaded.push(definition.name);
          return definition.handler?.(arguments_, context);
        },
      },
    });

    await expect(runtime.call('blocking', { value: 42 })).resolves.toMatchObject({ content: '42' });
    expect(offloaded).toEqual(['blocking']);
  });
});

describe('structured output validation', () => {
  const schema = outputSchema<{ answer: string; confidence: number }>(
    {
      type: 'object',
      properties: {
        answer: { type: 'string', minLength: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['answer', 'confidence'],
      additionalProperties: false,
    },
    (value) => value as { answer: string; confidence: number },
  );

  it('validates the parent JSON Schema subset and structural validators', () => {
    expect(validateOutputText('{"answer":"yes","confidence":0.9}', schema)).toEqual({
      answer: 'yes',
      confidence: 0.9,
    });
    expect(() => validateOutputText('{"answer":"yes","extra":true}', schema)).toThrow(
      OutputValidationError,
    );
    expect(() => validateOutputText('2', { oneOf: [{ const: 1 }, { type: 'string' }] })).toThrow(
      OutputValidationError,
    );
  });
});
