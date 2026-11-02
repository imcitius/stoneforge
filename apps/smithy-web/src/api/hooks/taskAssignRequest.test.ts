import { describe, expect, test } from 'vitest';
import { taskAssignRequest } from './taskAssignRequest';

describe('taskAssignRequest', () => {
  test('posts the assignee to the task assign endpoint', () => {
    const { path, init } = taskAssignRequest('el-abc', 'el-worker');
    expect(path).toBe('/tasks/el-abc/assign');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ assignee: 'el-worker' });
  });

  test('sends an explicit null to unassign', () => {
    const { init } = taskAssignRequest('el-abc', null);
    expect(JSON.parse(init.body as string)).toEqual({ assignee: null });
  });
});
