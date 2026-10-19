import { describe, test, expect, afterEach, setSystemTime } from 'bun:test';
import { TerminalRateLimitDetector } from './terminal-rate-limit.js';

describe('TerminalRateLimitDetector', () => {
  test('recognizes a weekly banner across ANSI chunks and ignores its redraw and upgrade hints', () => {
    const detector = new TerminalRateLimitDetector();
    expect(detector.push("\x1b[31mYou've hit your wee")).toBeUndefined();
    const limit = detector.push('kly limit · resets Oct 9 at 2am (Asia/Jerusalem)\x1b[0m\r\n');
    expect(limit?.message).toBe("You've hit your weekly limit · resets Oct 9 at 2am (Asia/Jerusalem)");
    expect(detector.push('Use your limit reset to reset it now: clau.de/reset\n/upgrade to increase your usage limit.\n')).toBeUndefined();
    detector.reset();
    expect(detector.push("You've hit your weekly limit · resets Oct 9 at 2am (Asia/Jerusalem)\n")).toBeUndefined();
  });
  test('recognizes the Claude session limit banner once across split terminal output', () => {
    const detector = new TerminalRateLimitDetector();
    expect(detector.push("You've hit your session ")).toBeUndefined();
    expect(detector.push('limit · resets 3:30am (Asia/Jerusalem)\r\n')?.message).toContain('session limit');
    expect(detector.push("You've hit your session limit · resets 3:30am (Asia/Jerusalem)\n")).toBeUndefined();
  });
  test('recognizes a complete ANSI-colored banner across chunks and ignores redraws', () => {
    const detector = new TerminalRateLimitDetector();
    expect(detector.push('\x1b[3')).toBeUndefined();
    expect(detector.push("1mYou've hit your limit · resets 11pm (UTC)\x1b[0m")).toBeUndefined();
    const limit = detector.push('\n');
    expect(limit?.message).toBe("You've hit your limit · resets 11pm (UTC)");
    expect(limit?.resetsAt.getTime()).toBeGreaterThan(Date.now());
    expect(detector.push("You've hit your limit · resets 11pm (UTC)\n")).toBeUndefined();
    detector.reset();
    expect(detector.push("You've hit your limit · resets 11pm (UTC)\n")).toBeUndefined();
    expect(detector.push("Weekly limit reached · resets tomorrow at 3pm\n")).toBeDefined();
  });

  test('recognizes the Codex usage banner and ignores explanations, quotes and echoed input', () => {
    const detector = new TerminalRateLimitDetector();
    expect(detector.push('The worker says usage limit reached, check later.\n')).toBeUndefined();
    expect(detector.push('> "Usage limit reached"\n')).toBeUndefined();
    expect(detector.push('❯ Usage limit reached\n')).toBeUndefined();
    expect(detector.push('› Usage limit reached\n')).toBeUndefined();
    expect(detector.push('[Message from system]: Usage limit reached\n')).toBeUndefined();
    expect(detector.push("❯ You've hit your weekly limit · resets Oct 9 at 2am (Asia/Jerusalem)\n")).toBeUndefined();
    expect(detector.push("You've hit your usage limit. Try again later.\n")?.message).toContain('usage limit');
  });

  test('ordinary silence and large output do not establish a limit', () => {
    const detector = new TerminalRateLimitDetector();
    expect(detector.push('')).toBeUndefined();
    expect(detector.push('x'.repeat(5000))).toBeUndefined();
    expect(detector.push('\n')).toBeUndefined();
    expect(detector.push('Usage limit reached\n')).toBeDefined();
  });
});


describe('Claude quota UI from the October 11 screenshot', () => {
  afterEach(() => setSystemTime());

  test('joins the decorated rejection and wrapped reset without a premature fallback', () => {
    setSystemTime(new Date('2026-10-11T12:08:00Z'));
    const detector = new TerminalRateLimitDetector();
    expect(detector.push("  └ \x1b[31mYou've hit your session limit · resets\x1b[0m\r\n")).toBeUndefined();
    const limit = detector.push('    4:30pm (Asia/Jerusalem)\r\n');
    expect(limit?.resetsAt.toISOString()).toBe('2026-10-11T13:30:00.000Z');
    expect(detector.push("  └ You've hit your session limit · resets\n    4:30pm (Asia/Jerusalem)\n")).toBeUndefined();
  });

  test('recognizes the waiting footer, including its warning icon', () => {
    setSystemTime(new Date('2026-10-11T12:08:00Z'));
    const limit = new TerminalRateLimitDetector().push('⚠️ Usage limit reached · limit resets 4:30pm (Asia/Jerusalem)\n');
    expect(limit?.resetsAt.toISOString()).toBe('2026-10-11T13:30:00.000Z');
  });

  test('joins the automatic retry status across chunks and uses the actual retry time', () => {
    setSystemTime(new Date('2026-10-11T12:08:00Z'));
    const detector = new TerminalRateLimitDetector();
    expect(detector.push('● Usage limit reached again · continuing\n')).toBeUndefined();
    const limit = detector.push('  automatically at 4:30pm (Asia/Jerusalem) · esc to\n  cancel\n');
    expect(limit?.resetsAt.toISOString()).toBe('2026-10-11T13:30:00.000Z');
  });

  test('processes complete lines before bounding a large PTY chunk', () => {
    const detector = new TerminalRateLimitDetector();
    const limit = detector.push("└ You've hit your session limit · resets 4:30pm (Asia/Jerusalem)\n" + 'ordinary output\n'.repeat(400));
    expect(limit?.message).toContain('session limit');
  });

  test('does not borrow a clock from unrelated output or echoed user instructions', () => {
    const detector = new TerminalRateLimitDetector();
    expect(detector.push("❯ You've hit your session limit · resets\n  4:30pm (Asia/Jerusalem)\n")).toBeUndefined();
    expect(detector.push("└ You've hit your session limit · resets\n")).toBeUndefined();
    expect(detector.push('ordinary output\n4:30pm (Asia/Jerusalem)\n')).toBeUndefined();
  });
});


describe('captured Claude PTY quota redraw', () => {
  afterEach(() => setSystemTime());
  // Quota-only excerpt from a read-only capture after resizing 48 -> 47 -> 48
  // columns. No prompt was sent; unrelated transcript and task IDs are omitted.
  const redraw = "\u23fa\u001b[3GUsage limit reached again \u00b7 \r\u001b[2C\u001b[1Bcontinuing automatically at 4:30pm \u00b7 \r\u001b[2C\u001b[1Besc to cancel\r\u001b[1B  \u23bf \u00a0\u001b[38;2;255;107;128mYou've hit your session limit \u00b7 resets \r\u001b[5C\u001b[1B4:30pm (Asia/Jerusalem)\r\u001b[5C\u001b[1B\u001b[39m\u001b[2mUse your limit reset to reset it now: \r\u001b[5C\u001b[1B\u001b[38;2;177;185;249mclau.de/reset\r\u001b[3B\u001b[22m\u001b[38;2;153;153;153m";

  test('recognizes actual cursor controls and wrapped lines, then suppresses replay', () => {
    setSystemTime(new Date('2026-10-11T12:08:00Z'));
    const detector = new TerminalRateLimitDetector();
    expect(detector.push(redraw)?.resetsAt.toISOString()).toBe('2026-10-11T13:30:00.000Z');
    detector.reset();
    expect(detector.push(redraw)).toBeUndefined();
    expect(detector.push(redraw.replaceAll('4:30pm', '5:30pm'))?.resetsAt.toISOString()).toBe('2026-10-11T14:30:00.000Z');
  });

  test('still obtains the timezone-qualified reset when every character arrives separately', () => {
    setSystemTime(new Date('2026-10-11T12:08:00Z'));
    const detector = new TerminalRateLimitDetector();
    const limits = [...redraw].flatMap(char => {
      const limit = detector.push(char);
      return limit ? [limit] : [];
    });
    const rejection = limits.find(limit => limit.message.includes("You've hit your session limit"));
    expect(rejection?.resetsAt.toISOString()).toBe('2026-10-11T13:30:00.000Z');
  });
});
