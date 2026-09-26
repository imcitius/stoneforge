import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logsBounds, logsHTML } from '../dist/logs.js';

test('Logs fit small and offset work areas including native window chrome', () => {
  for (const area of [
    { x: 0, y: 25, width: 1024, height: 600 },
    { x: -1280, y: -900, width: 1280, height: 800 },
    { x: 400, y: 100, width: 320, height: 300 },
  ]) {
    const bounds = logsBounds(area);
    assert(bounds.width > 0 && bounds.height > 0);
    assert(bounds.x >= area.x && bounds.y >= area.y);
    assert(bounds.x + bounds.width <= area.x + area.width);
    assert(bounds.y + bounds.height <= area.y + area.height);
  }
});

test('Logs retain the last 10,000 characters and escape untrusted text and names', () => {
  const html = logsHTML('<img src=x onerror=alert(1)>', 'discard-me' + 'x'.repeat(10_000) + '</pre><script>alert(1)</script>&');
  assert(!html.includes('discard-me'));
  assert(!html.includes('<script>'));
  assert(!html.includes('<img'));
  assert(html.includes('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;'));
  assert(html.includes('x'.repeat(10_000 - '</pre><script>alert(1)</script>&'.length)));
  assert(logsHTML('Empty', '').includes('No logs yet'));
  assert(logsHTML('Empty').includes('No logs yet'));
});
