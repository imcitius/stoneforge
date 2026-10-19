import { stripVTControlCharacters } from 'node:util';
import { isRateLimitMessage, parseRateLimitResetTime, getFallbackResetTime } from './rate-limit-parser.js';

const BANNER_START = /^(?:you['’]ve hit your (?:(?:session|usage|weekly) )?limit|weekly limit reached|(?:claude )?usage limit reached|API Error: Rate limit reached)\b/i;
const CONTINUATION = /^(?:resets?\b|(?:limit\s+)?resets?\b|continuing\b|automatically\s+at\b|at\s+\d|\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|[A-Za-z]{3,9}\s+\d{1,2}\b|tomorrow\b|\([A-Za-z][A-Za-z0-9_/+\-]*\))/i;

type TerminalLimit = { message: string; resetsAt: Date };

/** Recognize provider banners across wrapped lines; never renew them on redraw. */
export class TerminalRateLimitDetector {
  private buffer = '';
  private pending = '';
  private readonly reported = new Set<string>();

  reset(): void {
    this.buffer = '';
    this.pending = '';
  }

  push(data: string): TerminalLimit | undefined {
    // Process complete lines before bounding the unfinished tail. A terminal
    // redraw can exceed 4 KiB and contain the quota banner near its beginning.
    const lines = (this.buffer + data).split(/\r\n|\n|\r/);
    this.buffer = (lines.pop() ?? '').slice(-4096);
    let detected: TerminalLimit | undefined;
    let detectedPriority = -1;
    for (const line of lines) {
      const text = stripVTControlCharacters(line).trim().replace(/^[│┃•●⏺!⎿└⚠\uFE0F\s]+/u, '').trim();
      let message: string;
      if (BANNER_START.test(text)) {
        message = text;
      } else if (this.pending && CONTINUATION.test(text)) {
        message = `${this.pending} ${text}`;
      } else {
        this.pending = '';
        continue;
      }
      this.pending = '';
      if (!isRateLimitMessage(message)) continue;
      // Claude also prints a waiting status before its nested rejection. Only
      // within a recognized quota banner does this phrase specify a reset time.
      const resetText = message.replace(/continuing\s+automatically\s+at\s+/i, 'resets ')
        .replace(/\s*·\s*esc to(?:\s+cancel)?\s*$/i, '');
      const resetsAt = parseRateLimitResetTime(resetText);
      if (!resetsAt && /\b(?:resets?|continuing|automatically|at)\b|[·:]$/i.test(message)) {
        // Do not record a one-hour fallback while the actual clock is still on
        // the next terminal line/chunk. Unrelated output abandons this fragment.
        this.pending = message;
        continue;
      }
      if (this.reported.has(message)) continue;
      this.reported.add(message);
      // Prefer a timezone-qualified clock over the footer or a generic fallback.
      const priority = resetsAt ? (/\([A-Za-z][A-Za-z0-9_/+\-]*\)/.test(resetText) ? 2 : 1) : 0;
      if (priority >= detectedPriority) {
        detected = { message, resetsAt: resetsAt ?? getFallbackResetTime(message) };
        detectedPriority = priority;
      }
    }
    return detected;
  }
}
