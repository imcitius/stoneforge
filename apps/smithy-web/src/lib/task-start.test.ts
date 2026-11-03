import { describe, expect, test, vi } from 'vitest';
import {
  getStartAvailability,
  parseStartTaskError,
  requestStartTask,
  START_NEEDS_ASSIGNEE,
  StartTaskError,
} from './task-start';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('getStartAvailability', () => {
  test('unassigned open task shows a disabled Start with the assign hint', () => {
    expect(getStartAvailability({ status: 'open', assignee: undefined })).toEqual({
      visible: true, enabled: false, reason: START_NEEDS_ASSIGNEE,
    });
    expect(START_NEEDS_ASSIGNEE).toBe('Assign an agent first');
  });

  test('assigned open task can start as its assignee', () => {
    expect(getStartAvailability({ status: 'open', assignee: 'el-agent' as never })).toEqual({
      visible: true, enabled: true, agentId: 'el-agent',
    });
  });

  test('Start does not apply outside open status or without a task', () => {
    for (const status of ['in_progress', 'review', 'closed', 'backlog', 'blocked'] as const) {
      expect(getStartAvailability({ status, assignee: 'el-agent' as never }).visible).toBe(false);
    }
    expect(getStartAvailability(undefined)).toEqual({ visible: false, enabled: false });
  });
});

describe('parseStartTaskError', () => {
  test('400 invalid input keeps the server message', () => {
    const error = parseStartTaskError(400, {
      error: { code: 'INVALID_INPUT', message: 'agentId is required; sessionId must be a non-empty string when supplied' },
    });
    expect(error).toBeInstanceOf(StartTaskError);
    expect(error).toMatchObject({ status: 400, code: 'INVALID_INPUT', kind: 'invalid-input' });
    expect(error.message).toContain('Start request was rejected');
    expect(error.message).toContain('agentId is required');
  });

  test('422 for a non-agent or incoherent assignee explains assignment is needed', () => {
    const error = parseStartTaskError(422, {
      error: { code: 'CONCURRENT_MODIFICATION', message: 'Cannot start task el-1: the assignee is not a registered agent.' },
    });
    expect(error.kind).toBe('invalid-assignee');
    expect(error.message).toMatch(/assign it to a registered agent/);
    expect(error.message).toContain('the assignee is not a registered agent');
  });

  test('422 for a wrong status is classified as invalid-state', () => {
    const error = parseStartTaskError(422, {
      error: { message: "Cannot start task el-1: task is in 'closed' status; only open or in_progress work can be started." },
    });
    expect(error.kind).toBe('invalid-state');
    expect(error.message).toMatch(/current status/);
  });

  test('409 conflict asks to refresh and retry', () => {
    const error = parseStartTaskError(409, {
      error: { message: 'Cannot start task el-1: a different session is already recorded; start never replaces a recorded session.' },
    });
    expect(error.kind).toBe('conflict');
    expect(error.message).toMatch(/refresh and try again/);
  });

  test('explicit details.startErrorKind wins over status heuristics', () => {
    const error = parseStartTaskError(422, {
      error: { message: 'whatever', details: { startErrorKind: 'invalid-state' } },
    });
    expect(error.kind).toBe('invalid-state');
  });

  test('missing or malformed bodies still produce a visible message', () => {
    expect(parseStartTaskError(404, null)).toMatchObject({ kind: 'not-found', serverMessage: 'HTTP 404' });
    expect(parseStartTaskError(500, 'oops').message).toBe('HTTP 500');
  });
});

describe('requestStartTask', () => {
  test('happy path posts the assignee as agentId and returns the task', async () => {
    const task = { id: 'el-1', status: 'in_progress' };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { task }));
    await expect(requestStartTask('el-1', 'el-agent', fetchImpl)).resolves.toEqual({ task });
    expect(fetchImpl).toHaveBeenCalledWith('/api/tasks/el-1/start', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ agentId: 'el-agent' }),
    }));
  });

  test('unassigned start never calls the API and explains why', async () => {
    const fetchImpl = vi.fn();
    await expect(requestStartTask('el-1', '', fetchImpl)).rejects.toMatchObject({
      kind: 'invalid-assignee', serverMessage: START_NEEDS_ASSIGNEE,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    [400, 'invalid-input'],
    [409, 'conflict'],
    [422, 'invalid-assignee'],
  ] as const)('HTTP %i rejects with a StartTaskError (%s) instead of resolving', async (status, kind) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, { error: { code: 'X', message: 'Cannot start task el-1: reason' } }));
    const rejection = requestStartTask('el-1', 'el-agent', fetchImpl);
    await expect(rejection).rejects.toBeInstanceOf(StartTaskError);
    await expect(rejection).rejects.toMatchObject({ status, kind, serverMessage: 'Cannot start task el-1: reason' });
  });

  test('non-JSON error body still rejects with the status', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('bad json'); } }));
    await expect(requestStartTask('el-1', 'el-agent', fetchImpl)).rejects.toMatchObject({ status: 502, kind: 'unknown' });
  });
});
