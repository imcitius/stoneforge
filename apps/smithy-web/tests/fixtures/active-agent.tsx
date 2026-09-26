import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useIsFetching } from '@tanstack/react-query';
import type { EntityId, Timestamp } from '@stoneforge/core';
import { ActiveAgentCard } from '../../src/components/activity/ActiveAgentCard';
import '../../src/index.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function QueryStatus() {
  const pending = useIsFetching();
  return <span data-testid="fixture-query-status">{pending ? 'pending' : 'settled'}</span>;
}

const createdAt = '2026-09-26T00:00:00Z' as Timestamp;
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <main className="p-4 space-y-4">
      {(['interactive', 'headless'] as const).map(variant => {
        const id = `agent-${variant}` as EntityId;
        return <ActiveAgentCard key={id}
          agent={{ id, name: variant, type: 'entity', entityType: 'agent', status: 'active',
            createdAt, modifiedAt: createdAt }}
          session={{ id: `session-${variant}`, agentId: id, agentRole: 'worker',
            workerMode: variant === 'interactive' ? 'persistent' : 'ephemeral',
            status: 'running', createdAt }}
          onOpenTerminal={() => {}} onStop={() => {}} isStopping={false} />;
      })}
      <QueryStatus />
    </main>
  </QueryClientProvider>
);
