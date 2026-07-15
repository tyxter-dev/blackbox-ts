export interface StructuralValidator<T> {
  parse(value: unknown): T;
}

export interface OutputSchema<T> {
  readonly json_schema: Readonly<Record<string, unknown>>;
  readonly validator?: StructuralValidator<T> | ((value: unknown) => T);
}

export function outputSchema<T>(
  jsonSchema: Readonly<Record<string, unknown>>,
  validator?: StructuralValidator<T> | ((value: unknown) => T),
): OutputSchema<T> {
  return { json_schema: jsonSchema, validator };
}

export function isOutputSchema(value: unknown): value is OutputSchema<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'json_schema' in value &&
    typeof value.json_schema === 'object' &&
    value.json_schema !== null
  );
}
