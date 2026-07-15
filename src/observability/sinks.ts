import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentEvent } from '../core/events.js';
import { isRawEnvelope, redactRawEnvelope } from '../core/raw.js';

export interface EventSink {
  emit(event: AgentEvent): void | Promise<void>;
}

export class CallbackEventSink implements EventSink {
  constructor(private readonly callback: (event: AgentEvent) => void | Promise<void>) {}

  emit(event: AgentEvent): void | Promise<void> {
    return this.callback(event);
  }
}

export class MemoryEventSink implements EventSink {
  readonly events: AgentEvent[] = [];

  emit(event: AgentEvent): void {
    this.events.push(event);
  }
}

export class FanoutEventSink implements EventSink {
  readonly failures: unknown[] = [];

  constructor(private readonly sinks: readonly EventSink[]) {}

  async emit(event: AgentEvent): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map(async (sink) => sink.emit(event)));
    for (const result of results) {
      if (result.status === 'rejected') this.failures.push(result.reason);
    }
  }
}

export class RedactingEventSink implements EventSink {
  constructor(
    private readonly sink: EventSink,
    private readonly redact: (value: unknown) => unknown = redactSensitive,
  ) {}

  emit(event: AgentEvent): void | Promise<void> {
    return this.sink.emit({
      ...event,
      data: this.redact(event.data) as Readonly<Record<string, unknown>>,
      raw: this.redact(event.raw),
    });
  }
}

export class JSONLEventSink implements EventSink {
  private writeChain = Promise.resolve();

  constructor(readonly path: string) {}

  emit(event: AgentEvent): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
    });
    return this.writeChain;
  }
}

export function productionObservabilityPreset(sinks: readonly EventSink[]): FanoutEventSink {
  return new FanoutEventSink(sinks.map((sink) => new RedactingEventSink(sink)));
}

function redactSensitive(value: unknown): unknown {
  if (isRawEnvelope(value)) {
    return value.sensitivity === 'public' ? value : redactRawEnvelope(value);
  }
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactSensitive(child)]),
    );
  }
  return value;
}
