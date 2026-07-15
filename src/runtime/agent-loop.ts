import type { AgentMessage } from '../core/content.js';
import { textMessage } from '../core/content.js';
import { ApprovalManager, type ApprovalDecision, type ApprovalTicket } from '../core/approvals.js';
import {
  ApprovalError,
  AgentRuntimeError,
  OutputValidationError,
  ProviderExecutionError,
  ProviderNotConfiguredError,
  ProviderNotFoundError,
} from '../core/errors.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { createRuntimeId } from '../core/ids.js';
import { createRunItem, type RunItem } from '../core/items.js';
import { allow, AllowAllPolicy, type Policy, type PolicyCheckpoint } from '../core/policy.js';
import type { AgentResult, OutputSpec, ToolPayload } from '../core/results.js';
import type { ProviderState } from '../core/state.js';
import { addUsage, type ModelUsage } from '../core/usage.js';
import { validateOutputText, type JsonSchema } from '../output/validation.js';
import { isOutputSchema, type OutputSchema } from '../output/schema.js';
import { parseProviderModelRef } from '../core/refs.js';
import type { Artifact } from '../core/artifacts.js';
import { ModelRuntime, type ModelRunRequest } from './model-runtime.js';
import { ToolRuntime } from '../tools/runtime.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  ToolsetRuntime,
  type ToolBudget,
  type ToolSelectionMode,
  type Toolset,
} from '../tools/catalog.js';
import { toolResult, type ToolDefinition } from '../tools/types.js';
import { composePrompt, type PromptFragment } from '../planning/index.js';

export interface AgentRunRequest<T = string> extends Omit<
  ModelRunRequest,
  'tools' | 'output' | 'model' | 'trace_id'
> {
  readonly model: string;
  readonly trace_id: string;
  readonly tools?: readonly (string | ToolDefinition)[];
  readonly output?: OutputSpec<OutputSchema<T> | JsonSchema>;
  readonly max_iterations?: number;
  readonly fallback_providers?: readonly string[];
  readonly mock_tools?: boolean;
  readonly tool_timeout_ms?: number;
  readonly tool_max_concurrent?: number;
  readonly tool_execution_context?: Readonly<Record<string, unknown>>;
  readonly toolsets?: readonly Toolset[];
  readonly tool_selection?: ToolSelectionMode;
  readonly tool_budget?: ToolBudget;
  readonly approval_manager?: ApprovalManager;
  readonly session_id?: string;
  readonly prompt_fragments?: readonly PromptFragment[];
  readonly policy?: Policy;
}

interface ToolCall {
  readonly item: RunItem;
  readonly name: string;
  readonly call_id: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

type ResolvedModelRunRequest = ModelRunRequest & {
  readonly model: string;
  readonly trace_id: string;
};

export class AgentLoop {
  constructor(
    readonly models: ModelRuntime,
    readonly tools: ToolRegistry,
    readonly policy: Policy = new AllowAllPolicy(),
  ) {}

  async *stream<T = string>(request: AgentRunRequest<T>): AsyncIterable<AgentEvent> {
    const runId = createRuntimeId('run');
    let sequence = 0;
    const stamp = (event: AgentEvent): AgentEvent => ({
      ...event,
      run_id: runId,
      sequence: sequence++,
      trace_id: event.trace_id ?? request.trace_id,
      session_id: event.session_id ?? request.session_id,
    });

    yield stamp(
      createAgentEvent({
        type: AgentEventTypes.RUN_STARTED,
        trace_id: request.trace_id,
        data: { model: request.model },
      }),
    );

    try {
      yield* this.streamBody(request, stamp);
    } catch (cause) {
      yield stamp(
        createAgentEvent({
          type: AgentEventTypes.RUN_FAILED,
          trace_id: request.trace_id,
          data: { error: errorData(cause) },
        }),
      );
      throw cause;
    }
  }

  async run<T = string>(request: AgentRunRequest<T>): Promise<AgentResult<T>> {
    return collectAgentResult(this.stream(request));
  }

  private async *streamBody<T>(
    request: AgentRunRequest<T>,
    stamp: (event: AgentEvent) => AgentEvent,
  ): AsyncIterable<AgentEvent> {
    const session = this.tools.session();
    const selectedNames: string[] = [];
    const directNames: string[] = [];
    for (const tool of request.tools ?? []) {
      if (typeof tool === 'string') {
        directNames.push(tool);
      } else {
        if (!session.has(tool.name)) session.register(tool);
        directNames.push(tool.name);
      }
    }
    const toolsetRuntime =
      request.toolsets === undefined
        ? undefined
        : new ToolsetRuntime(
            request.toolsets,
            request.tool_selection ?? 'static',
            request.tool_budget,
          );
    if (toolsetRuntime !== undefined) {
      for (const tool of toolsetRuntime.allDefinitions()) {
        if (!session.has(tool.name)) session.register(tool);
      }
      for (const metaTool of toolsetRuntime.metaTools()) {
        if (session.has(metaTool.name)) {
          throw new AgentRuntimeError(
            `Reserved dynamic tool '${metaTool.name}' is already registered.`,
            {
              code: 'reserved_tool_name',
            },
          );
        }
        session.register(metaTool);
      }
    }
    const output = request.output;
    const finalizerName = 'submit_final_output';
    if (output?.strategy === 'finalizer_tool') {
      session.register({
        name: finalizerName,
        description: 'Submit the final structured output.',
        input_schema: schemaForProvider(output.schema),
      });
      directNames.push(finalizerName);
    }
    refreshSelectedNames(selectedNames, directNames, toolsetRuntime);
    if (toolsetRuntime !== undefined) {
      yield stamp(
        createAgentEvent({
          type: AgentEventTypes.TOOL_SET_CHANGED,
          trace_id: request.trace_id,
          data: { reason: 'initialized', ...toolsetRuntime.metadata() },
        }),
      );
    }

    const toolRuntime = new ToolRuntime(session, {
      timeout_ms: request.tool_timeout_ms,
      max_concurrency: request.tool_max_concurrent,
      context: request.tool_execution_context,
    });
    const messages: AgentMessage[] =
      typeof request.input === 'string' ? [textMessage('user', request.input)] : [...request.input];
    const allItems: RunItem[] = [];
    const artifacts: Artifact[] = [];
    const payloads: ToolPayload[] = [];
    const fallbackAttempts: Array<Readonly<Record<string, unknown>>> = [];
    let providerState = request.provider_state;
    let usage: ModelUsage | undefined;
    let validationAttempts = 0;
    let lastText: string;
    const maxIterations = request.max_iterations ?? 12;
    const promptPlan = composePrompt(request.instructions, request.prompt_fragments);
    yield stamp(
      createAgentEvent({
        type: AgentEventTypes.PROMPT_PLAN_CREATED,
        trace_id: request.trace_id,
        data: {
          fingerprint: promptPlan.fingerprint,
          selected: promptPlan.selected.map((fragment) => fragment.id),
          skipped: promptPlan.skipped.map((fragment) => fragment.id),
          cache_sections: promptPlan.cache_sections,
        },
      }),
    );

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const modelApproval = await prepareApproval(
        request.policy ?? this.policy,
        request.approval_manager,
        'before_model_request',
        'model.run',
        { model: request.model, iteration },
      );
      if (modelApproval !== undefined) {
        yield stamp(
          createAgentEvent({
            type: AgentEventTypes.APPROVAL_REQUESTED,
            trace_id: request.trace_id,
            data: { request: modelApproval.request },
          }),
        );
        const decision = await waitForApproval(modelApproval.decision, request.signal);
        yield stamp(approvalEvent(request.trace_id, modelApproval.request.id, decision));
        assertApproved(decision, 'model.run');
      }

      const result = await this.runWithFallback(
        modelRequestForAgent(
          { ...request, instructions: promptPlan.instructions || undefined },
          messages,
          session.toProviderTools(selectedNames),
          providerState,
        ),
        request.fallback_providers ?? [],
        fallbackAttempts,
      );
      for (const event of result.events ?? []) yield stamp(event);
      allItems.push(...(result.items ?? []));
      artifacts.push(...(result.artifacts ?? []));
      providerState = result.provider_state ?? providerState;
      usage = addUsage(usage, result.usage);
      lastText = result.output_text;

      const calls = (result.items ?? [])
        .filter((item) => item.type === 'function_call')
        .map(toToolCall);
      const finalizer = calls.find((call) => call.name === finalizerName);
      if (finalizer !== undefined && output !== undefined) {
        validationAttempts += 1;
        const raw = JSON.stringify(finalizer.arguments);
        let value = validateStructuredOutput(raw, output);
        const finalApproval = await prepareApproval(
          request.policy ?? this.policy,
          request.approval_manager,
          'before_final_output',
          'output.finalize',
          { output: value },
        );
        if (finalApproval !== undefined) {
          yield stamp(
            createAgentEvent({
              type: AgentEventTypes.APPROVAL_REQUESTED,
              trace_id: request.trace_id,
              data: { request: finalApproval.request },
            }),
          );
          const decision = await waitForApproval(finalApproval.decision, request.signal);
          yield stamp(approvalEvent(request.trace_id, finalApproval.request.id, decision));
          assertApproved(decision, 'output.finalize');
          if (decision.modified_arguments?.output !== undefined) {
            value = decision.modified_arguments.output as T;
          }
        }
        yield completedEvent(
          stamp,
          request,
          value,
          raw,
          allItems,
          artifacts,
          payloads,
          providerState,
          {
            usage,
            validation_attempts: validationAttempts,
            fallback: fallbackMetadata(fallbackAttempts, result.provider),
            tool_choice: toolsetRuntime?.metadata(),
          },
        );
        return;
      }

      if (calls.length === 0) {
        try {
          validationAttempts += output === undefined ? 0 : 1;
          let value =
            output === undefined ? (lastText as T) : validateStructuredOutput(lastText, output);
          const finalApproval = await prepareApproval(
            request.policy ?? this.policy,
            request.approval_manager,
            'before_final_output',
            'output.finalize',
            { output: value },
          );
          if (finalApproval !== undefined) {
            yield stamp(
              createAgentEvent({
                type: AgentEventTypes.APPROVAL_REQUESTED,
                trace_id: request.trace_id,
                data: { request: finalApproval.request },
              }),
            );
            const decision = await waitForApproval(finalApproval.decision, request.signal);
            yield stamp(approvalEvent(request.trace_id, finalApproval.request.id, decision));
            assertApproved(decision, 'output.finalize');
            if (decision.modified_arguments?.output !== undefined) {
              value = decision.modified_arguments.output as T;
            }
          }
          yield completedEvent(
            stamp,
            request,
            value,
            lastText,
            allItems,
            artifacts,
            payloads,
            providerState,
            {
              usage,
              validation_attempts: validationAttempts,
              fallback: fallbackMetadata(fallbackAttempts, result.provider),
              tool_choice: toolsetRuntime?.metadata(),
            },
          );
          return;
        } catch (cause) {
          if (
            cause instanceof OutputValidationError &&
            output?.strategy === 'posthoc_parse_with_retry' &&
            validationAttempts <= output.max_validation_retries
          ) {
            messages.push(
              textMessage(
                'user',
                `Your previous output did not match the required JSON schema. Repair it and return only valid JSON. Error: ${cause.message}`,
              ),
            );
            continue;
          }
          throw cause;
        }
      }

      if (lastText) messages.push(textMessage('assistant', lastText));
      const executableCalls = calls.filter((call) => call.name !== finalizerName);
      toolsetRuntime?.assertParallel(executableCalls.length);
      toolsetRuntime?.recordCalls(executableCalls.length);
      const visibleBefore = toolsetRuntime?.visibleNames().join('\u0000');
      const authorizedCalls: ToolCall[] = [];
      for (const call of executableCalls) {
        yield stamp(
          createAgentEvent({
            type: AgentEventTypes.TOOL_CALL_REQUESTED,
            trace_id: request.trace_id,
            item_id: call.item.id,
            data: { name: call.name, call_id: call.call_id, arguments: call.arguments },
          }),
        );
        const decision =
          (await (request.policy ?? this.policy).check({
            checkpoint: 'before_tool_call',
            action: call.name,
            arguments: call.arguments,
            metadata: {},
          })) ?? allow();
        let effectiveArguments = call.arguments;
        if (decision.verdict === 'deny') {
          throw new ApprovalError(
            decision.reason ?? `Action '${call.name}' was denied by policy.`,
            {
              code: 'policy_denied',
            },
          );
        }
        if (decision.verdict === 'require_approval') {
          if (request.approval_manager === undefined) {
            throw new ApprovalError(decision.reason ?? `Action '${call.name}' requires approval.`, {
              code: 'approval_required',
            });
          }
          const ticket = request.approval_manager.request(call.name, {
            reason: decision.reason,
            data: {
              checkpoint: 'before_tool_call',
              arguments: call.arguments,
              policy_metadata: decision.metadata,
            },
          });
          yield stamp(
            createAgentEvent({
              type: AgentEventTypes.APPROVAL_REQUESTED,
              trace_id: request.trace_id,
              item_id: call.item.id,
              data: { request: ticket.request },
            }),
          );
          const approval = await waitForApproval(ticket.decision, request.signal);
          yield stamp(
            createAgentEvent({
              type: approval.approved
                ? AgentEventTypes.APPROVAL_APPROVED
                : AgentEventTypes.APPROVAL_DENIED,
              trace_id: request.trace_id,
              item_id: call.item.id,
              data: { approval_id: ticket.request.id, decision: approval },
            }),
          );
          if (!approval.approved) {
            throw new ApprovalError(approval.reason ?? `Action '${call.name}' was denied.`, {
              code: 'approval_denied',
            });
          }
          effectiveArguments = approval.modified_arguments ?? effectiveArguments;
        }
        authorizedCalls.push({ ...call, arguments: effectiveArguments });
        yield stamp(
          createAgentEvent({
            type: AgentEventTypes.TOOL_CALL_STARTED,
            trace_id: request.trace_id,
            item_id: call.item.id,
            data: { name: call.name, call_id: call.call_id, arguments: effectiveArguments },
          }),
        );
      }

      const results = await Promise.all(
        authorizedCalls.map(async (call) => {
          try {
            return await toolRuntime.call(call.name, call.arguments, {
              mock: request.mock_tools,
            });
          } catch (cause) {
            return toolResult(cause instanceof Error ? cause.message : 'Tool failed.', {
              is_error: true,
              metadata: { error: errorData(cause) },
            });
          }
        }),
      );

      for (const [index, call] of authorizedCalls.entries()) {
        const resultValue = results[index];
        if (resultValue === undefined) continue;
        const item = createRunItem({
          type: 'function_result',
          provider: 'local',
          status: resultValue.is_error ? 'failed' : 'completed',
          parent_id: call.item.id,
          data: {
            name: call.name,
            call_id: call.call_id,
            content: resultValue.content,
            is_error: resultValue.is_error,
          },
        });
        allItems.push(item);
        if (resultValue.payload !== undefined) {
          payloads.push({
            tool_name: call.name,
            call_id: call.call_id,
            payload: resultValue.payload,
          });
        }
        yield stamp(
          createAgentEvent({
            type: resultValue.is_error
              ? AgentEventTypes.TOOL_CALL_FAILED
              : AgentEventTypes.TOOL_CALL_COMPLETED,
            trace_id: request.trace_id,
            item_id: item.id,
            data: { ...item.data, payload: resultValue.payload },
          }),
        );
        messages.push({
          role: 'tool',
          tool_call_id: call.call_id,
          content: [
            {
              type: 'tool_result',
              tool_call_id: call.call_id,
              output: resultValue.content,
              is_error: resultValue.is_error,
            },
          ],
        });
      }
      if (
        toolsetRuntime !== undefined &&
        visibleBefore !== toolsetRuntime.visibleNames().join('\u0000')
      ) {
        refreshSelectedNames(selectedNames, directNames, toolsetRuntime);
        yield stamp(
          createAgentEvent({
            type: AgentEventTypes.TOOL_SET_CHANGED,
            trace_id: request.trace_id,
            data: { reason: 'tools_loaded', ...toolsetRuntime.metadata() },
          }),
        );
      }
    }

    throw new AgentRuntimeError(`Agent loop exceeded ${maxIterations} iterations.`, {
      code: 'max_iterations_exceeded',
    });
  }

  private async runWithFallback(
    request: ResolvedModelRunRequest,
    fallbackProviders: readonly string[],
    attempts: Array<Readonly<Record<string, unknown>>>,
  ) {
    const candidates = [
      request.model,
      ...fallbackProviders.map((value) => fallbackRef(value, request.model, request.provider)),
    ];
    let lastError: unknown;
    for (const candidate of candidates) {
      const parsed = parseProviderModelRef(candidate, request.provider);
      if (
        request.provider_state !== undefined &&
        request.provider_state.provider !== parsed.provider
      ) {
        attempts.push({
          provider: parsed.provider,
          model: parsed.model,
          status: 'skipped_state_mismatch',
        });
        continue;
      }
      try {
        const result = await this.models.run({ ...request, model: candidate });
        attempts.push({ provider: parsed.provider, model: parsed.model, status: 'completed' });
        return result;
      } catch (cause) {
        if (!isFallbackError(cause)) throw cause;
        lastError = cause;
        attempts.push({
          provider: parsed.provider,
          model: parsed.model,
          status: 'failed',
          error: errorData(cause),
        });
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new ProviderNotFoundError('fallback', []);
  }
}

async function waitForApproval(
  decision: Promise<ApprovalDecision>,
  signal: AbortSignal | undefined,
): Promise<ApprovalDecision> {
  if (signal === undefined) return decision;
  if (signal.aborted) throw abortError(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    void decision.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(cause instanceof Error ? cause : new AgentRuntimeError('Approval wait failed.'));
      },
    );
  });
}

async function prepareApproval(
  policy: Policy,
  manager: ApprovalManager | undefined,
  checkpoint: PolicyCheckpoint,
  action: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<ApprovalTicket | undefined> {
  const decision =
    (await policy.check({ checkpoint, action, arguments: arguments_, metadata: {} })) ?? allow();
  if (decision.verdict === 'allow') return undefined;
  if (decision.verdict === 'deny') {
    throw new ApprovalError(decision.reason ?? `Action '${action}' was denied by policy.`, {
      code: 'policy_denied',
    });
  }
  if (manager === undefined) {
    throw new ApprovalError(decision.reason ?? `Action '${action}' requires approval.`, {
      code: 'approval_required',
    });
  }
  return manager.request(action, {
    reason: decision.reason,
    data: { checkpoint, arguments: arguments_, policy_metadata: decision.metadata },
  });
}

function approvalEvent(
  traceId: string,
  approvalId: string,
  decision: ApprovalDecision,
): AgentEvent {
  return createAgentEvent({
    type: decision.approved ? AgentEventTypes.APPROVAL_APPROVED : AgentEventTypes.APPROVAL_DENIED,
    trace_id: traceId,
    data: { approval_id: approvalId, decision },
  });
}

function assertApproved(decision: ApprovalDecision, action: string): void {
  if (!decision.approved) {
    throw new ApprovalError(decision.reason ?? `Action '${action}' was denied.`, {
      code: 'approval_denied',
    });
  }
}

function abortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new AgentRuntimeError('Agent run was cancelled while waiting for approval.', {
        code: 'run_cancelled',
        cause: reason,
      });
}

function refreshSelectedNames(
  selectedNames: string[],
  directNames: readonly string[],
  toolsetRuntime: ToolsetRuntime | undefined,
): void {
  const next = [
    ...directNames,
    ...(toolsetRuntime?.metaTools().map((tool) => tool.name) ?? []),
    ...(toolsetRuntime?.visibleNames() ?? []),
  ];
  selectedNames.splice(0, selectedNames.length, ...new Set(next));
}

export async function collectAgentResult<T>(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentResult<T>> {
  const events: AgentEvent[] = [];
  let completed: AgentEvent | undefined;
  for await (const event of stream) {
    events.push(event);
    if (event.type === AgentEventTypes.RUN_COMPLETED) completed = event;
  }
  if (completed === undefined) {
    throw new AgentRuntimeError('Agent run ended without a completion event.', {
      code: 'run_incomplete',
    });
  }
  return {
    output: completed.data.output as T,
    text: typeof completed.data.text === 'string' ? completed.data.text : '',
    events,
    items: readArray<RunItem>(completed.data.items),
    artifacts: readArray<Artifact>(completed.data.artifacts),
    payloads: readArray<ToolPayload>(completed.data.payloads),
    provider_state: readProviderState(completed.data.provider_state),
    metadata: readRecord(completed.data.metadata),
  };
}

function completedEvent<T>(
  stamp: (event: AgentEvent) => AgentEvent,
  request: AgentRunRequest<T>,
  output: T,
  text: string,
  items: readonly RunItem[],
  artifacts: readonly Artifact[],
  payloads: readonly ToolPayload[],
  providerState: ProviderState | undefined,
  metadata: Readonly<Record<string, unknown>>,
): AgentEvent {
  return stamp(
    createAgentEvent({
      type: AgentEventTypes.RUN_COMPLETED,
      trace_id: request.trace_id,
      data: {
        output,
        text,
        items,
        artifacts,
        payloads,
        provider_state: providerState,
        metadata,
      },
    }),
  );
}

function toToolCall(item: RunItem): ToolCall {
  const name = typeof item.data.name === 'string' ? item.data.name : undefined;
  if (name === undefined) {
    throw new AgentRuntimeError(`Function-call item '${item.id}' has no tool name.`, {
      code: 'invalid_tool_call',
    });
  }
  return {
    item,
    name,
    call_id: typeof item.data.call_id === 'string' ? item.data.call_id : item.id,
    arguments: parseArguments(item.data.arguments),
  };
}

function parseArguments(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Readonly<Record<string, unknown>>;
      }
    } catch (cause) {
      throw new AgentRuntimeError('Tool arguments are not valid JSON.', {
        code: 'invalid_tool_arguments',
        cause,
      });
    }
  }
  throw new AgentRuntimeError('Tool arguments must be a JSON object.', {
    code: 'invalid_tool_arguments',
  });
}

function validateStructuredOutput<T>(
  text: string,
  output: OutputSpec<OutputSchema<T> | JsonSchema>,
): T {
  if (output.schema === undefined) return text as T;
  return validateOutputText<T>(text, output.schema);
}

function schemaForProvider(schema: OutputSchema<unknown> | JsonSchema | undefined): JsonSchema {
  if (schema === undefined) return { type: 'object' };
  return isOutputSchema(schema) ? schema.json_schema : schema;
}

function modelRequestForAgent<T>(
  request: AgentRunRequest<T>,
  input: readonly AgentMessage[],
  tools: readonly ToolDefinition[],
  providerState: ProviderState | undefined,
): ResolvedModelRunRequest {
  return {
    model: request.model,
    provider: request.provider,
    input,
    instructions: request.instructions,
    tools,
    hosted_tools: request.hosted_tools,
    mcp_connections: request.mcp_connections,
    workspace: request.workspace,
    provider_state: providerState,
    response_format: request.response_format,
    output:
      request.output?.strategy === 'provider_native'
        ? { ...request.output, schema: schemaForProvider(request.output.schema) }
        : undefined,
    controls: request.controls,
    max_tokens: request.max_tokens,
    max_output_tokens: request.max_output_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    tool_choice: request.tool_choice,
    parallel_tool_calls: request.parallel_tool_calls,
    reasoning_effort: request.reasoning_effort,
    verbosity: request.verbosity,
    state_mode: request.state_mode,
    modalities: request.modalities,
    tool_search: request.tool_search,
    compaction: request.compaction,
    cache: request.cache,
    background: request.background,
    store: request.store,
    include: request.include,
    extra: request.extra,
    trace_id: request.trace_id,
    signal: request.signal,
  };
}

function fallbackRef(value: string, primary: string, providerHint?: string): string {
  if (value.includes(':') || value.includes('/')) return value;
  const model = parseProviderModelRef(primary, providerHint).model;
  return `${value}:${model}`;
}

function isFallbackError(value: unknown): boolean {
  return (
    value instanceof ProviderExecutionError ||
    value instanceof ProviderNotFoundError ||
    value instanceof ProviderNotConfiguredError
  );
}

function fallbackMetadata(
  attempts: readonly Readonly<Record<string, unknown>>[],
  provider: string | undefined,
): Readonly<Record<string, unknown>> {
  return { attempts, provider_used: provider };
}

function errorData(value: unknown): Readonly<Record<string, unknown>> {
  return value instanceof Error
    ? {
        name: value.name,
        message: value.message,
        code: 'code' in value ? value.code : undefined,
      }
    : { message: String(value) };
}

function readArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readProviderState(value: unknown): ProviderState | undefined {
  const record = readRecord(value);
  return typeof record.provider === 'string' ? (record as unknown as ProviderState) : undefined;
}
