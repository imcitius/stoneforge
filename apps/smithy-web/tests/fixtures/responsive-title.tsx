import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MetricsPage } from '../../src/routes/metrics';
import '../../src/index.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <main className="p-4 @container"><MetricsPage /></main>
  </QueryClientProvider>
);
