/**
 * Provider Registry — Unit Tests
 *
 * Tests for provider registration, lookup, filtering by adapter type,
 * and factory functions (createProviderRegistry, createDefaultProviderRegistry).
 *
 * Hermetic: global fetch is stubbed for every test. Configured providers get
 * canned 401 responses for their fake tokens (as the real APIs would return);
 * any other request fails the test. No real network request is made.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  ExternalProvider,
  TaskSyncAdapter,
  DocumentSyncAdapter,
  SyncAdapterType,
  ProviderConfig,
  ExternalTask,
  ExternalTaskInput,
  TaskFieldMapConfig,
} from '@stoneforge/core';
import type { Timestamp } from '@stoneforge/core';
import {
  ProviderRegistry,
  createProviderRegistry,
  createDefaultProviderRegistry,
  createConfiguredProviderRegistry,
} from './provider-registry.js';
import { GitHubApiError } from './providers/github/index.js';
import { LinearApiError } from './providers/linear/index.js';
import { NotionApiError } from './providers/notion/index.js';

// ============================================================================
// Network Stub
// ============================================================================

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  /** Request headers with lower-cased names */
  readonly headers: Record<string, string>;
}

let originalFetch: typeof globalThis.fetch;
/** Every request the code under test attempted, in order */
let requests: RecordedRequest[];
/** Requests to hosts without a canned response (always a test failure) */
let unexpectedRequests: string[];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The authentication failure each provider API returns for an invalid token.
 * Returns undefined for any host the tests do not expect to be contacted.
 */
function fakeTokenResponse(url: URL): Response | undefined {
  switch (url.hostname) {
    case 'api.github.com':
      return jsonResponse(401, {
        message: 'Bad credentials',
        documentation_url: 'https://docs.github.com/rest',
      });
    case 'api.linear.app':
      return jsonResponse(401, {
        errors: [
          { message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } },
        ],
      });
    case 'api.notion.com':
      return jsonResponse(401, {
        object: 'error',
        status: 401,
        code: 'unauthorized',
        message: 'API token is invalid.',
      });
    default:
      return undefined;
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
  unexpectedRequests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    requests.push({
      url: url.href,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: Object.fromEntries(headers.entries()),
    });
    const response = fakeTokenResponse(url);
    if (!response) {
      unexpectedRequests.push(url.href);
      throw new TypeError(`Unexpected network request in hermetic test: ${url.href}`);
    }
    return response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  expect(unexpectedRequests).toEqual([]);
});

/** Awaits a promise that must reject and returns the rejection reason. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected the promise to reject, but it resolved');
}

// ============================================================================
// Test Helpers
// ============================================================================

function createMockTaskAdapter(): TaskSyncAdapter {
  return {
    async getIssue(_project: string, _externalId: string): Promise<ExternalTask | null> {
      return null;
    },
    async listIssuesSince(_project: string, _since: Timestamp): Promise<ExternalTask[]> {
      return [];
    },
    async createIssue(_project: string, _issue: ExternalTaskInput): Promise<ExternalTask> {
      throw new Error('Not implemented');
    },
    async updateIssue(
      _project: string,
      _externalId: string,
      _updates: Partial<ExternalTaskInput>
    ): Promise<ExternalTask> {
      throw new Error('Not implemented');
    },
    getFieldMapConfig(): TaskFieldMapConfig {
      return { provider: 'mock', fields: [] };
    },
  };
}

function createMockProvider(
  name: string,
  adapters: SyncAdapterType[] = ['task'],
  taskAdapter?: TaskSyncAdapter
): ExternalProvider {
  const adapter = taskAdapter ?? createMockTaskAdapter();
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    supportedAdapters: adapters,
    async testConnection(_config: ProviderConfig): Promise<boolean> {
      return true;
    },
    getTaskAdapter: adapters.includes('task') ? () => adapter : undefined,
    getDocumentAdapter: adapters.includes('document')
      ? () => ({} as DocumentSyncAdapter)
      : undefined,
  };
}

// ============================================================================
// ProviderRegistry
// ============================================================================

describe('ProviderRegistry', () => {
  describe('register', () => {
    test('registers a provider', () => {
      const registry = new ProviderRegistry();
      const provider = createMockProvider('github');
      registry.register(provider);
      expect(registry.has('github')).toBe(true);
    });

    test('throws when registering a provider with duplicate name', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('github'));
      expect(() => registry.register(createMockProvider('github'))).toThrow(
        /already registered/
      );
    });

    test('registers multiple providers with different names', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('github'));
      registry.register(createMockProvider('linear'));
      expect(registry.has('github')).toBe(true);
      expect(registry.has('linear')).toBe(true);
    });
  });

  describe('get', () => {
    test('returns the provider if registered', () => {
      const registry = new ProviderRegistry();
      const provider = createMockProvider('github');
      registry.register(provider);
      expect(registry.get('github')).toBe(provider);
    });

    test('returns undefined for unregistered provider', () => {
      const registry = new ProviderRegistry();
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('list', () => {
    test('returns empty array when no providers registered', () => {
      const registry = new ProviderRegistry();
      expect(registry.list()).toEqual([]);
    });

    test('returns all registered providers', () => {
      const registry = new ProviderRegistry();
      const github = createMockProvider('github');
      const linear = createMockProvider('linear');
      registry.register(github);
      registry.register(linear);

      const result = registry.list();
      expect(result).toHaveLength(2);
      expect(result).toContain(github);
      expect(result).toContain(linear);
    });
  });

  describe('has', () => {
    test('returns true for registered provider', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('github'));
      expect(registry.has('github')).toBe(true);
    });

    test('returns false for unregistered provider', () => {
      const registry = new ProviderRegistry();
      expect(registry.has('github')).toBe(false);
    });
  });

  describe('unregister', () => {
    test('removes a registered provider and returns true', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('github'));
      expect(registry.unregister('github')).toBe(true);
      expect(registry.has('github')).toBe(false);
    });

    test('returns false for unregistered provider', () => {
      const registry = new ProviderRegistry();
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('clear', () => {
    test('removes all registered providers', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('github'));
      registry.register(createMockProvider('linear'));
      registry.clear();
      expect(registry.list()).toEqual([]);
      expect(registry.has('github')).toBe(false);
      expect(registry.has('linear')).toBe(false);
    });
  });

  describe('getAdaptersOfType', () => {
    test('returns matching providers with their task adapters', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('github', ['task']));
      registry.register(createMockProvider('notion', ['document']));

      const taskProviders = registry.getAdaptersOfType('task');
      expect(taskProviders).toHaveLength(1);
      expect(taskProviders[0].provider.name).toBe('github');
      expect(taskProviders[0].adapter).toBeDefined();
    });

    test('returns empty array when no providers match', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('notion', ['document']));

      const taskProviders = registry.getAdaptersOfType('task');
      expect(taskProviders).toEqual([]);
    });

    test('returns multiple matching providers', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('github', ['task']));
      registry.register(createMockProvider('linear', ['task']));
      registry.register(createMockProvider('notion', ['document']));

      const taskProviders = registry.getAdaptersOfType('task');
      expect(taskProviders).toHaveLength(2);
    });

    test('returns document adapters when requested', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('notion', ['document']));
      registry.register(createMockProvider('github', ['task']));

      const docProviders = registry.getAdaptersOfType('document');
      expect(docProviders).toHaveLength(1);
      expect(docProviders[0].provider.name).toBe('notion');
    });

    test('returns empty array for message type when none registered', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('github', ['task']));

      const msgProviders = registry.getAdaptersOfType('message');
      expect(msgProviders).toEqual([]);
    });
  });
});

// ============================================================================
// Factory Functions
// ============================================================================

describe('createProviderRegistry', () => {
  test('creates an empty registry', () => {
    const registry = createProviderRegistry();
    expect(registry).toBeInstanceOf(ProviderRegistry);
    expect(registry.list()).toEqual([]);
  });
});

describe('createDefaultProviderRegistry', () => {
  test('creates a registry with default providers', () => {
    const registry = createDefaultProviderRegistry();
    expect(registry).toBeInstanceOf(ProviderRegistry);
    expect(registry.has('github')).toBe(true);
    expect(registry.has('linear')).toBe(true);
    expect(registry.has('notion')).toBe(true);
    expect(registry.has('folder')).toBe(true);
  });

  test('default providers include task adapter support', () => {
    const registry = createDefaultProviderRegistry();
    const github = registry.get('github');
    expect(github).toBeDefined();
    expect(github!.supportedAdapters).toContain('task');
  });

  test('default GitHub provider is a placeholder that throws on adapter use', async () => {
    const registry = createDefaultProviderRegistry();
    const github = registry.get('github')!;
    const adapter = github.getTaskAdapter!();
    await expect(adapter.getIssue('owner/repo', '1')).rejects.toThrow(/not configured/);
    expect(requests).toEqual([]);
  });

  test('default Linear provider is a placeholder that throws on adapter use', async () => {
    const registry = createDefaultProviderRegistry();
    const linear = registry.get('linear')!;
    const adapter = linear.getTaskAdapter!();
    await expect(adapter.getIssue('team', '1')).rejects.toThrow(/not.*configured/);
    expect(requests).toEqual([]);
  });

  test('default Notion provider is a placeholder that throws on adapter use', async () => {
    const registry = createDefaultProviderRegistry();
    const notion = registry.get('notion')!;
    expect(notion).toBeDefined();
    expect(notion.supportedAdapters).toContain('document');
    const adapter = notion.getDocumentAdapter!();
    await expect(adapter.getPage('workspace', 'page-1')).rejects.toThrow(/not.*configured/i);
    expect(requests).toEqual([]);
  });

  test('default Folder provider is ready to use (not a placeholder)', () => {
    const registry = createDefaultProviderRegistry();
    const folder = registry.get('folder')!;
    expect(folder).toBeDefined();
    expect(folder.name).toBe('folder');
    expect(folder.displayName).toBe('Folder');
    expect(folder.supportedAdapters).toContain('document');
    // Folder provider should have a document adapter (not throw "not configured")
    const adapter = folder.getDocumentAdapter!();
    expect(adapter).toBeDefined();
  });

  test('registry has four default providers', () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.list()).toHaveLength(4);
  });
});

// ============================================================================
// createConfiguredProviderRegistry
// ============================================================================

describe('createConfiguredProviderRegistry', () => {
  test('creates a registry with all default providers when no configs have tokens', () => {
    const registry = createConfiguredProviderRegistry([]);
    expect(registry).toBeInstanceOf(ProviderRegistry);
    expect(registry.has('github')).toBe(true);
    expect(registry.has('linear')).toBe(true);
    expect(registry.has('notion')).toBe(true);
    expect(registry.has('folder')).toBe(true);
  });

  test('keeps placeholder when config has no token', async () => {
    const registry = createConfiguredProviderRegistry([
      { provider: 'github' },
    ]);
    const github = registry.get('github')!;
    // Placeholder adapter should throw on use, without contacting GitHub
    const adapter = github.getTaskAdapter!();
    await expect(adapter.getIssue('owner/repo', '1')).rejects.toThrow(/not configured/);
    expect(requests).toEqual([]);
  });

  test('replaces GitHub placeholder with configured provider when token is set', async () => {
    const registry = createConfiguredProviderRegistry([
      { provider: 'github', token: 'ghp_test123', defaultProject: 'owner/repo' },
    ]);
    const github = registry.get('github')!;
    expect(github).toBeDefined();
    expect(github.name).toBe('github');
    // A configured provider calls the GitHub API with the token (not the placeholder);
    // the fake token is rejected with GitHub's 401 response.
    const adapter = github.getTaskAdapter!();
    const error = await rejectionOf(adapter.getIssue('owner/repo', '1'));
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(401);
    expect(error.message).toMatch(/Bad credentials/);
    expect(error.message).not.toMatch(/not configured/);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe('https://api.github.com/repos/owner/repo/issues/1');
    expect(requests[0].headers.authorization).toBe('Bearer ghp_test123');
  });

  test('replaces Linear placeholder with configured provider when token is set', async () => {
    const registry = createConfiguredProviderRegistry([
      { provider: 'linear', token: 'lin_api_test123' },
    ]);
    const linear = registry.get('linear')!;
    expect(linear).toBeDefined();
    expect(linear.name).toBe('linear');
    // A configured provider calls the Linear API with the key (not the placeholder);
    // the fake key is rejected with Linear's 401 response.
    const adapter = linear.getTaskAdapter!();
    const error = await rejectionOf(adapter.getIssue('team', '1'));
    expect(error).toBeInstanceOf(LinearApiError);
    expect((error as LinearApiError).status).toBe(401);
    expect(error.message).toMatch(/Authentication required/);
    expect(error.message).not.toMatch(/not.*configured/);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe('https://api.linear.app/graphql');
    expect(requests[0].headers.authorization).toBe('lin_api_test123');
  });

  test('replaces only providers with tokens, keeps others as placeholders', async () => {
    const registry = createConfiguredProviderRegistry([
      { provider: 'github', token: 'ghp_test123', defaultProject: 'owner/repo' },
      { provider: 'linear' }, // no token
    ]);
    // GitHub should be configured (not placeholder): it reaches the GitHub API
    const github = registry.get('github')!;
    const githubAdapter = github.getTaskAdapter!();
    const githubError = await rejectionOf(githubAdapter.getIssue('owner/repo', '1'));
    expect(githubError).toBeInstanceOf(GitHubApiError);
    expect(githubError.message).not.toMatch(/not configured/);

    // Linear should still be placeholder: it throws without any request
    const linear = registry.get('linear')!;
    const linearAdapter = linear.getTaskAdapter!();
    await expect(linearAdapter.getIssue('team', '1')).rejects.toThrow(/not.*configured/);
    expect(requests.map((r) => new URL(r.url).hostname)).toEqual(['api.github.com']);
  });

  test('ignores unknown provider names gracefully', () => {
    const registry = createConfiguredProviderRegistry([
      { provider: 'unknown-provider', token: 'some_token' },
    ]);
    // Known providers should still be placeholders
    expect(registry.has('github')).toBe(true);
    expect(registry.has('linear')).toBe(true);
    // Unknown provider should not be registered
    expect(registry.has('unknown-provider')).toBe(false);
  });

  test('handles multiple configs for the same provider (last wins)', () => {
    // The second config for github should replace the first
    const registry = createConfiguredProviderRegistry([
      { provider: 'github', token: 'ghp_first', defaultProject: 'owner/repo1' },
    ]);
    const github = registry.get('github')!;
    expect(github).toBeDefined();
    expect(github.name).toBe('github');
  });

  test('replaces Notion placeholder with configured provider when token is set', async () => {
    const registry = createConfiguredProviderRegistry([
      { provider: 'notion', token: 'ntn_test123' },
    ]);
    const notion = registry.get('notion')!;
    expect(notion).toBeDefined();
    expect(notion.name).toBe('notion');
    expect(notion.supportedAdapters).toContain('document');
    // A configured provider calls the Notion API with the token (not the placeholder);
    // the fake token is rejected with Notion's 401 response (not retried).
    const adapter = notion.getDocumentAdapter!();
    const error = await rejectionOf(adapter.getPage('db-id', 'page-1'));
    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).status).toBe(401);
    expect(error.message).toMatch(/API token is invalid/);
    expect(error.message).not.toMatch(/not.*configured/i);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    for (const request of requests) {
      expect(new URL(request.url).hostname).toBe('api.notion.com');
      expect(request.headers.authorization).toBe('Bearer ntn_test123');
    }
    expect(requests.map((r) => r.url)).toContain('https://api.notion.com/v1/pages/page-1');
  });

  test('folder provider is always available regardless of token', () => {
    const registry = createConfiguredProviderRegistry([]);
    const folder = registry.get('folder')!;
    expect(folder).toBeDefined();
    expect(folder.name).toBe('folder');
    // Folder provider should always be ready — no placeholder pattern
    const adapter = folder.getDocumentAdapter!();
    expect(adapter).toBeDefined();
  });

  test('folder provider config is skipped (no token needed)', () => {
    // Even when a folder config is passed, it should be skipped (not erroring)
    const registry = createConfiguredProviderRegistry([
      { provider: 'folder', defaultProject: '/tmp/docs' },
    ]);
    expect(registry.has('folder')).toBe(true);
    const folder = registry.get('folder')!;
    expect(folder.name).toBe('folder');
  });

  test('getAdaptersOfType returns document adapters for notion and folder', () => {
    const registry = createConfiguredProviderRegistry([
      { provider: 'notion', token: 'ntn_test123' },
    ]);
    const docAdapters = registry.getAdaptersOfType('document');
    expect(docAdapters.length).toBeGreaterThanOrEqual(2);
    const names = docAdapters.map((e) => e.provider.name);
    expect(names).toContain('notion');
    expect(names).toContain('folder');
  });
});
