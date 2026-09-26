import type { Command, GlobalOptions, CommandResult } from '@stoneforge/quarry/cli';
import { success, failure, ExitCode, getOrchestratorUrl, orchestratorFetch } from '@stoneforge/quarry/cli';

type Options = GlobalOptions & { 'target-branch'?: string; 'test-command'?: string };
async function request(method: string, suffix = '', body?: unknown): Promise<CommandResult> {
  try {
    const url = await getOrchestratorUrl();
    const response = await orchestratorFetch(url + '/api/repositories' + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    return response.ok ? success(data, JSON.stringify(data, null, 2)) : failure(String(data.error), ExitCode.VALIDATION);
  } catch (error) { return failure(String(error), ExitCode.GENERAL_ERROR); }
}
export const repoCommand: Command = {
  name: 'repo', description: 'Manage code repositories in this Stoneforge project',
  usage: 'sf repo <list|add|remove>',
  handler: () => request('GET'),
  subcommands: {
    list: { name: 'list', description: 'List project repositories', usage: 'sf repo list', handler: () => request('GET') },
    add: {
      name: 'add', description: 'Register an existing Git checkout (one entry per repository)', usage: 'sf repo add <id> <path> [--target-branch main] [--test-command "pnpm test"]',
      options: [{ name: 'target-branch', description: 'Default merge target', hasValue: true }, { name: 'test-command', description: 'Verification command', hasValue: true }],
      handler: async (args, options: Options) => args.length !== 2 ? failure('Expected repository ID and path', ExitCode.INVALID_ARGUMENTS) : request('POST', '', { id: args[0], path: args[1], targetBranch: options['target-branch'], testCommand: options['test-command'] }),
    },
    remove: { name: 'remove', description: 'Unregister an unused repository; never deletes files', usage: 'sf repo remove <id>', handler: async args => !args[0] ? failure('Repository ID required', ExitCode.INVALID_ARGUMENTS) : request('DELETE', '/' + encodeURIComponent(args[0])) },
  },
};
