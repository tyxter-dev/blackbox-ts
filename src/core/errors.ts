export interface RuntimeErrorOptions {
  readonly code?: string;
  readonly cause?: unknown;
}

export class BlackboxError extends Error {
  readonly code?: string;
  override readonly cause?: unknown;

  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.cause = options.cause;
  }
}

export class AgentRuntimeError extends BlackboxError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super(message, { code: 'agent_runtime_error', ...options });
  }
}

export class InvalidProviderRefError extends AgentRuntimeError {
  constructor(ref: string, message?: string) {
    super(message ?? `Invalid provider reference '${ref}'. Use provider:model.`, {
      code: 'invalid_provider_ref',
    });
  }
}

export class ProviderNotRegisteredError extends AgentRuntimeError {
  constructor(provider: string, known: readonly string[]) {
    super(`No model provider registered for '${provider}'. Known providers: ${known.join(', ') || 'none'}.`, {
      code: 'provider_not_registered',
    });
  }
}

export class ProviderNotConfiguredError extends AgentRuntimeError {
  constructor(provider: string, missing: string) {
    super(`Provider '${provider}' is not configured: missing ${missing}.`, {
      code: 'provider_not_configured',
    });
  }
}

export class ProviderExecutionError extends AgentRuntimeError {
  readonly provider: string;
  readonly statusCode: number;
  readonly responseBody: unknown;

  constructor(provider: string, statusCode: number, responseBody: unknown, cause?: unknown) {
    super(`Provider '${provider}' request failed with status ${statusCode}.`, {
      code: 'provider_execution_error',
      cause,
    });
    this.provider = provider;
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class UnsupportedCapabilityError extends AgentRuntimeError {
  readonly provider: string;
  readonly capability: string;
  readonly detail: unknown;

  constructor(provider: string, capability: string, detail?: { readonly reason?: string }) {
    super(
      detail?.reason
        ? `Provider '${provider}' does not support '${capability}': ${detail.reason}`
        : `Provider '${provider}' does not support '${capability}'.`,
      { code: 'unsupported_capability' },
    );
    this.provider = provider;
    this.capability = capability;
    this.detail = detail;
  }
}
