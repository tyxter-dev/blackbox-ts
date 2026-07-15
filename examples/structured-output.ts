import { structuredOutput } from 'blackbox-ts/output';

export const answerOutput = structuredOutput(
  {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
  { strategy: 'posthoc_parse_with_retry' },
);
