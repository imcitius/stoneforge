import type { RecordMetricInput } from './metrics-service.js';

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Usage belongs to one spawn, never to the agent's current configuration. */
export class SessionMetricsTracker {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheCreation = 0;
  private available = false;
  private readonly models = new Set<string>();
  private readonly messages = new Set<string>();

  constructor(private readonly provider: string, private model?: string) {}

  observe(event: { type: string; subtype?: string; raw?: Record<string, unknown> }): void {
    if (this.provider === 'codex') {
      if (event.type === 'system' && event.subtype === 'usage') {
        this.addUsage(event.raw?.usage as Usage | undefined, true);
      }
      return;
    }
    if (this.provider !== 'claude-code') return;

    // One SDK message can be decomposed into several text/tool events.
    const message = event.raw?.message as { id?: string; model?: string; usage?: Usage } | undefined;
    if (message && typeof message === 'object') {
      if (message.model) {
        this.models.add(message.model);
        this.model = this.models.size === 1 ? message.model : 'unknown';
      }
      if (!message.id || !this.messages.has(message.id)) {
        if (this.addUsage(message.usage, false) && message.id) this.messages.add(message.id);
      }
    }
    if (event.type === 'result') {
      this.addUsage(event.raw?.usage as Usage | undefined, true);
      const modelUsage = event.raw?.modelUsage as Record<string, {
        cacheReadInputTokens?: number; cacheCreationInputTokens?: number;
      }> | undefined;
      if (modelUsage) {
        const models = Object.keys(modelUsage);
        // A session-level row cannot accurately price a multi-model session.
        for (const model of models) this.models.add(model);
        this.model = this.models.size === 1 ? [...this.models][0] : 'unknown';
        this.cacheRead = Math.max(this.cacheRead, Object.values(modelUsage)
          .reduce((sum, value) => sum + (value.cacheReadInputTokens ?? 0), 0));
        this.cacheCreation = Math.max(this.cacheCreation, Object.values(modelUsage)
          .reduce((sum, value) => sum + (value.cacheCreationInputTokens ?? 0), 0));
      }
    }
  }

  private addUsage(usage: Usage | undefined, cumulative: boolean): boolean {
    if (!usage) return false;
    const values = [usage.input_tokens, usage.output_tokens,
      usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0];
    if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return false;
    const [input, output, read, creation] = values as number[];
    this.input = cumulative ? Math.max(this.input, input) : this.input + input;
    this.output = cumulative ? Math.max(this.output, output) : this.output + output;
    this.cacheRead = cumulative ? Math.max(this.cacheRead, read) : this.cacheRead + read;
    this.cacheCreation = cumulative ? Math.max(this.cacheCreation, creation) : this.cacheCreation + creation;
    this.available = true;
    return true;
  }

  snapshot(): Pick<RecordMetricInput, 'provider' | 'model' | 'inputTokens' | 'outputTokens' |
    'cacheReadTokens' | 'cacheCreationTokens' | 'usageAvailable'> {
    return {
      provider: this.provider,
      model: this.model,
      inputTokens: this.input,
      outputTokens: this.output,
      cacheReadTokens: this.cacheRead,
      cacheCreationTokens: this.cacheCreation,
      usageAvailable: this.available,
    };
  }
}
