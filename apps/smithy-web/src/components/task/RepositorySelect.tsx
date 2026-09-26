import { useId } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Task } from '../../api/types';

type Repository = { id: string; path: string; targetBranch?: string; error?: string };
export function RepositorySelect({ value, onChange, disabled = false, saving = false }: { value: string; onChange: (id: string) => void; disabled?: boolean; saving?: boolean }) {
  const id = useId();
  const query = useQuery({ queryKey: ['repositories'], queryFn: async (): Promise<{ repositories: Repository[] }> => {
    const response = await fetch('/api/repositories');
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not load repositories');
    return data;
  }});
  const repositories = query.data?.repositories ?? [];
  return <div className="space-y-1">
    <label htmlFor={id} className="block text-sm text-[var(--color-text-secondary)]">Repository</label>
    <select id={id} value={value} disabled={disabled || saving || query.isPending || !!query.error || !repositories.length}
      onChange={e => onChange(e.target.value)} className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text)] disabled:opacity-60">
      <option value="" disabled>{query.isPending ? 'Loading repositories…' : repositories.length === 1 ? `Automatic: ${repositories[0].id}` : 'Choose repository'}</option>
      {value && !repositories.some(r => r.id === value) && <option value={value}>{value} (unavailable)</option>}
      {repositories.map(r => <option key={r.id} value={r.id} disabled={!!r.error}>{r.id} — {r.error ? 'unavailable' : r.path}</option>)}
    </select>
    {query.error ? <p role="alert" className="text-sm text-[var(--color-text-secondary)]">{query.error.message} <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></p> : !query.isPending && !repositories.length ? <p className="text-sm text-[var(--color-text-secondary)]">Add a code repository with the Desktop Repositories button or sf repo add.</p> : saving ? <p role="status" className="text-xs text-[var(--color-text-secondary)]">Saving…</p> : disabled ? <p className="text-xs text-[var(--color-text-secondary)]">Fixed for this task after dispatch.</p> : null}
  </div>;
}
export function TaskRepositoryField({ task }: { task: Task }) {
  const client = useQueryClient();
  const mutation = useMutation({ mutationFn: async (repositoryId: string) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/repository`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryId }) });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Could not save repository');
    return result;
  }, onSuccess: () => { void client.invalidateQueries({ queryKey: ['tasks'] }); void client.invalidateQueries({ queryKey: ['task', task.id] }); } });
  const meta = task.metadata?.orchestrator;
  return <div className="col-span-2">
    <RepositorySelect value={task.repositoryId ?? ''} saving={mutation.isPending} disabled={!!(meta?.repositoryLocked || meta?.branch || meta?.worktree || meta?.sessionId)} onChange={id => mutation.mutate(id)} />
    {mutation.error && <p role="alert" className="text-sm text-[var(--color-text-secondary)]">{mutation.error.message}</p>}
  </div>;
}
