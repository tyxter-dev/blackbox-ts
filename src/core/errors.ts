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

export class ConfigurationError extends AgentRuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super(message, { code: 'configuration_error', ...options });
  }
}

export class InvalidProviderRefError extends AgentRuntimeError {
  constructor(ref: string, message?: string) {
    super(message ?? `Invalid provider reference '${ref}'. Use provider:model.`, {
      code: 'invalid_provider_ref',
    });
  }
}

export class ProviderNotFoundError extends AgentRuntimeError {
  readonly provider: string;
  readonly known: readonly string[];

  constructor(provider: string, known: readonly string[] = [], options: RuntimeErrorOptions = {}) {
    super(
      `No model provider registered for '${provider}'. Known providers: ${known.join(', ') || 'none'}.`,
      { code: 'provider_not_found', ...options },
    );
    this.provider = provider;
    this.known = known;
  }
}

export class ProviderNotRegisteredError extends ProviderNotFoundError {
  constructor(provider: string, known: readonly string[]) {
    super(provider, known, { code: 'provider_not_registered' });
  }
}

export class ProviderNotConfiguredError extends ConfigurationError {
  readonly provider: string;
  readonly missing: string;

  constructor(provider: string, missing: string) {
    super(`Provider '${provider}' is not configured: missing ${missing}.`, {
      code: 'provider_not_configured',
    });
    this.provider = provider;
    this.missing = missing;
  }
}

export class CapabilityError extends AgentRuntimeError {
  readonly feature?: string;

  constructor(message: string, feature?: string, options: RuntimeErrorOptions = {}) {
    super(message, { code: 'capability_error', ...options });
    this.feature = feature;
  }
}

export class UnsupportedFeatureError extends CapabilityError {
  constructor(feature: string, reason?: string) {
    super(reason === undefined ? `Feature '${feature}' is not supported.` : reason, feature, {
      code: 'unsupported_feature',
    });
  }
}

export class ProviderExecutionError extends AgentRuntimeError {
  readonly provider: string;
  readonly statusCode: number;
  readonly responseBody: unknown;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly safeToRetry: boolean;

  constructor(
    provider: string,
    statusCode: number,
    responseBody: unknown,
    cause?: unknown,
    details: {
      readonly request_id?: string;
      readonly retry_after_ms?: number;
      readonly safe_to_retry?: boolean;
    } = {},
  ) {
    super(`Provider '${provider}' request failed with status ${statusCode}.`, {
      code: 'provider_execution_error',
      cause,
    });
    this.provider = provider;
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.requestId = details.request_id;
    this.retryAfterMs = details.retry_after_ms;
    this.safeToRetry =
      (details.safe_to_retry ?? statusCode === 408) || statusCode === 429 || statusCode >= 500;
  }
}

export class UnsupportedCapabilityError extends UnsupportedFeatureError {
  readonly provider: string;
  readonly capability: string;
  readonly detail: unknown;

  constructor(provider: string, capability: string, detail?: { readonly reason?: string }) {
    super(
      capability,
      detail?.reason
        ? `Provider '${provider}' does not support '${capability}': ${detail.reason}`
        : `Provider '${provider}' does not support '${capability}'.`,
    );
    this.provider = provider;
    this.capability = capability;
    this.detail = detail;
  }
}

export class AgentWebhookError extends AgentRuntimeError {}
export class AgentWebhookVerificationError extends AgentWebhookError {}
export class ToolExecutionError extends AgentRuntimeError {}
export class ApprovalError extends AgentRuntimeError {}
export class ArtifactError extends AgentRuntimeError {}
export class WorkspaceError extends AgentRuntimeError {}
export class WorkSourceError extends AgentRuntimeError {}
export class WorkItemNotFoundError extends WorkSourceError {}

export interface SessionErrorDetails {
  readonly session_id?: string;
  readonly provider?: string;
  readonly status?: string;
  readonly operation?: string;
  readonly safe_to_retry?: boolean;
  readonly cause?: unknown;
}

export class SessionError extends AgentRuntimeError {
  readonly session_id?: string;
  readonly provider?: string;
  readonly status?: string;
  readonly operation?: string;
  readonly safe_to_retry: boolean;

  constructor(message: string, details: SessionErrorDetails = {}) {
    super(message, { code: 'session_error', cause: details.cause });
    this.session_id = details.session_id;
    this.provider = details.provider;
    this.status = details.status;
    this.operation = details.operation;
    this.safe_to_retry = details.safe_to_retry ?? false;
  }
}

export class SessionNotFoundError extends SessionError {}
export class SessionCursorError extends SessionError {}

export class SessionResumeError extends SessionError {
  constructor(message: string, details: SessionErrorDetails = {}) {
    super(message, { ...details, safe_to_retry: details.safe_to_retry ?? true });
  }
}

export class SessionBusyError extends SessionError {
  constructor(message: string, details: SessionErrorDetails = {}) {
    super(message, { ...details, safe_to_retry: details.safe_to_retry ?? true });
  }
}

export class SessionTerminalError extends SessionError {}

export class MCPError extends AgentRuntimeError {}

export interface MCPAuthenticationErrorDetails {
  readonly server?: string;
  readonly status_code?: number;
  readonly www_authenticate?: string;
  readonly resource_metadata_url?: string;
  readonly scope?: string;
  readonly safe_to_retry?: boolean;
  readonly cause?: unknown;
}

export class MCPAuthenticationError extends MCPError {
  readonly server?: string;
  readonly status_code?: number;
  readonly www_authenticate?: string;
  readonly resource_metadata_url?: string;
  readonly scope?: string;
  readonly safe_to_retry: boolean;

  constructor(message: string, details: MCPAuthenticationErrorDetails = {}) {
    super(message, { code: 'mcp_authentication_error', cause: details.cause });
    this.server = details.server;
    this.status_code = details.status_code;
    this.www_authenticate = details.www_authenticate;
    this.resource_metadata_url = details.resource_metadata_url;
    this.scope = details.scope;
    this.safe_to_retry = details.safe_to_retry ?? true;
  }
}

export class RealtimeError extends AgentRuntimeError {}
export class RealtimeConnectionError extends RealtimeError {}
export class RealtimeSessionError extends RealtimeError {}
export class RealtimeTransportError extends RealtimeError {}
export class RealtimeUnsupportedFeatureError extends CapabilityError {}
export class RealtimeMediaError extends RealtimeError {}

export class OutputValidationError extends AgentRuntimeError {
  readonly raw_text: string;

  constructor(message: string, raw_text: string, cause?: unknown) {
    super(message, { code: 'output_validation_error', cause });
    this.raw_text = raw_text;
  }
}
