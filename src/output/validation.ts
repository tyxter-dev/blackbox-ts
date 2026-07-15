import { OutputValidationError } from '../core/errors.js';
import { isOutputSchema, type OutputSchema } from './schema.js';

export type JsonSchema = Readonly<Record<string, unknown>>;

export function validateOutputText<T>(text: string, schema: OutputSchema<T> | JsonSchema): T {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new OutputValidationError('Model output is not valid JSON.', text, cause);
  }

  const jsonSchema = isOutputSchema(schema) ? schema.json_schema : schema;
  try {
    validateJsonSchema(value, jsonSchema);
    if (isOutputSchema(schema) && schema.validator !== undefined) {
      return typeof schema.validator === 'function'
        ? schema.validator(value)
        : schema.validator.parse(value);
    }
    return value as T;
  } catch (cause) {
    if (cause instanceof OutputValidationError) throw cause;
    throw new OutputValidationError(
      'Model output does not match the requested schema.',
      text,
      cause,
    );
  }
}

export function validateJsonSchema(value: unknown, schema: JsonSchema, path = '$'): void {
  validateCombinators(value, schema, path);

  if ('const' in schema && !deepEqual(value, schema.const)) {
    fail(path, `must equal ${display(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    fail(path, `must be one of ${schema.enum.map(display).join(', ')}`);
  }

  const expectedTypes = Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  if (expectedTypes.length > 0 && !expectedTypes.some((type) => matchesType(value, type))) {
    fail(path, `must be ${expectedTypes.join(' or ')}`);
  }

  if (typeof value === 'string') validateString(value, schema, path);
  if (typeof value === 'number') validateNumber(value, schema, path);
  if (Array.isArray(value)) validateArray(value, schema, path);
  if (isRecord(value)) validateObject(value, schema, path);
}

function validateCombinators(value: unknown, schema: JsonSchema, path: string): void {
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) validateJsonSchema(value, asSchema(child), path);
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter((child) => schemaMatches(value, asSchema(child), path));
    if (matches.length === 0) fail(path, 'must match at least one anyOf schema');
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((child) => schemaMatches(value, asSchema(child), path));
    if (matches.length !== 1) fail(path, 'must match exactly one oneOf schema');
  }
}

function validateObject(
  value: Readonly<Record<string, unknown>>,
  schema: JsonSchema,
  path: string,
): void {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  for (const key of required) {
    if (!(key in value)) fail(`${path}.${key}`, 'is required');
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, child] of Object.entries(value)) {
    if (key in properties) {
      validateJsonSchema(child, asSchema(properties[key]), `${path}.${key}`);
      continue;
    }
    if (schema.additionalProperties === false) fail(`${path}.${key}`, 'is not allowed');
    if (isRecord(schema.additionalProperties)) {
      validateJsonSchema(child, schema.additionalProperties, `${path}.${key}`);
    }
  }

  compareNumber(Object.keys(value).length, schema.minProperties, path, 'must have at least');
  compareMaximum(Object.keys(value).length, schema.maxProperties, path, 'must have at most');
}

function validateArray(value: readonly unknown[], schema: JsonSchema, path: string): void {
  compareNumber(value.length, schema.minItems, path, 'must contain at least');
  compareMaximum(value.length, schema.maxItems, path, 'must contain at most');
  if (schema.uniqueItems === true) {
    const serialized = value.map((item) => JSON.stringify(item));
    if (new Set(serialized).size !== serialized.length) fail(path, 'must contain unique items');
  }
  if (isRecord(schema.items)) {
    value.forEach((item, index) =>
      validateJsonSchema(item, schema.items as JsonSchema, `${path}[${index}]`),
    );
  }
}

function validateString(value: string, schema: JsonSchema, path: string): void {
  compareNumber(value.length, schema.minLength, path, 'must have at least');
  compareMaximum(value.length, schema.maxLength, path, 'must have at most');
  if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
    fail(path, `must match pattern ${schema.pattern}`);
  }
}

function validateNumber(value: number, schema: JsonSchema, path: string): void {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    fail(path, `must be at least ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    fail(path, `must be at most ${schema.maximum}`);
  }
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
    fail(path, `must be greater than ${schema.exclusiveMinimum}`);
  }
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
    fail(path, `must be less than ${schema.exclusiveMaximum}`);
  }
}

function compareNumber(value: number, expected: unknown, path: string, message: string): void {
  if (typeof expected === 'number' && value < expected) fail(path, `${message} ${expected}`);
}

function compareMaximum(value: number, expected: unknown, path: string, message: string): void {
  if (typeof expected === 'number' && value > expected) fail(path, `${message} ${expected}`);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean':
      return typeof value === type;
    default:
      return false;
  }
}

function schemaMatches(value: unknown, schema: JsonSchema, path: string): boolean {
  try {
    validateJsonSchema(value, schema, path);
    return true;
  } catch {
    return false;
  }
}

function asSchema(value: unknown): JsonSchema {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function display(value: unknown): string {
  return JSON.stringify(value);
}

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}.`);
}
