import type { Command, GlobalOptions, CommandResult } from '@stoneforge/quarry/cli';
import { success, failure, ExitCode, getOrchestratorUrl, orchestratorFetch } from '@stoneforge/quarry/cli';

type Options = GlobalOptions & { 'target-branch'?: string; 'test-command'?: string; 'node-path'?: string; 'clear-node-path'?: boolean; delivery?: string };
const DELIVERY_OPTION = { name: 'delivery', description: "Task branch delivery: 'remote' (default, push to origin) or 'local' (never push or delete remote refs)", hasValue: true };
const validDelivery = (value: string | undefined) => value === undefined || value === 'remote' || value === 'local';
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
  usage: 'sf repo <list|add|update|remove>',
  handler: () => request('GET'),
  subcommands: {
    list: { name: 'list', description: 'List project repositories', usage: 'sf repo list', handler: () => request('GET') },
    add: {
      name: 'add', description: 'Register an existing Git checkout (one entry per repository)', usage: 'sf repo add <id> <path> [--target-branch main] [--test-command "pnpm test"] [--node-path /abs/bin/node] [--delivery remote|local]',
      options: [{ name: 'target-branch', description: 'Default merge target', hasValue: true }, { name: 'test-command', description: 'Verification command', hasValue: true }, { name: 'node-path', description: 'Node executable for project install, workers and checks (not used by Stoneforge itself)', hasValue: true }, DELIVERY_OPTION],
      handler: async (args, options: Options) => {
        if (args.length !== 2) return failure('Expected repository ID and path', ExitCode.INVALID_ARGUMENTS);
        if (!validDelivery(options.delivery)) return failure("--delivery must be 'remote' or 'local'", ExitCode.INVALID_ARGUMENTS);
        return request('POST', '', { id: args[0], path: args[1], targetBranch: options['target-branch'], testCommand: options['test-command'], nodePath: options['node-path'], delivery: options.delivery });
      },
    },
    update: {
      name: 'update', description: "Set or clear a repository's project Node executable or delivery mode", usage: 'sf repo update <id> [--node-path /abs/bin/node | --clear-node-path] [--delivery remote|local]',
      options: [{ name: 'node-path', description: 'Absolute Node executable for project install, workers and checks', hasValue: true }, { name: 'clear-node-path', description: 'Return to automatic selection from engines.node/.nvmrc' }, DELIVERY_OPTION],
      handler: async (args, options: Options) => {
        if (args.length !== 1) return failure('Expected repository ID', ExitCode.INVALID_ARGUMENTS);
        if (options['node-path'] && options['clear-node-path']) return failure('Specify at most one of --node-path or --clear-node-path', ExitCode.INVALID_ARGUMENTS);
        if (!options['node-path'] && !options['clear-node-path'] && options.delivery === undefined) return failure('Specify --node-path, --clear-node-path or --delivery', ExitCode.INVALID_ARGUMENTS);
        if (!validDelivery(options.delivery)) return failure("--delivery must be 'remote' or 'local'", ExitCode.INVALID_ARGUMENTS);
        const body: Record<string, unknown> = {};
        if (options['node-path'] || options['clear-node-path']) body.nodePath = options['clear-node-path'] ? null : options['node-path'];
        if (options.delivery !== undefined) body.delivery = options.delivery;
        return request('PATCH', '/' + encodeURIComponent(args[0]), body);
      },
    },
    remove: { name: 'remove', description: 'Unregister an unused repository; never deletes files', usage: 'sf repo remove <id>', handler: async args => !args[0] ? failure('Repository ID required', ExitCode.INVALID_ARGUMENTS) : request('DELETE', '/' + encodeURIComponent(args[0])) },
  },
};
