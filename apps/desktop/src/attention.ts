import type { ProjectManager, Instance } from './manager.js';

export interface AttentionNotice { projectId: string; sessionId: string; agentId: string; attentionId: string; kind: 'input' | 'permission' }
interface AttentionSession {
  id: string; agentId: string; agentRole: string; status: string;
  attention?: { id: string; since: string; kind: 'input' | 'permission' };
}

/** Observe every running project, independent of the visible renderer/window. */
export class AttentionMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;
  private seen = new Map<string, string>();
  private lastNotification = new Map<string, number>();
  constructor(private readonly manager: ProjectManager, private readonly notify: (notice: AttentionNotice) => void) {}
  start(): void {
    this.stopped = false;
    this.timer ??= setInterval(() => { void this.poll(); }, 3000);
    this.timer.unref();
    void this.poll();
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); this.timer = undefined; }
  async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      await Promise.all([...this.manager.instances].map(async ([id, instance]) => {
        const project = this.manager.projects.get(id);
        if (!project || project.state !== 'ready' || !instance.endpoint || instance.stopping) return;
        try {
          if (!await this.manager.isCurrent(id, instance)) return;
          const response = await fetch(instance.endpoint + '/api/sessions?role=director&status=running', {
            headers: this.manager.headers(instance), signal: AbortSignal.timeout(5000), redirect: 'error',
          });
          if (!response.ok) return;
          const body = await response.json() as { sessions?: AttentionSession[] };
          // A stopped/replaced project must never receive an old fetch result.
          if (this.stopped || this.manager.instances.get(id) !== instance || project.state !== 'ready' || instance.stopping) return;
          if (!Array.isArray(body.sessions)) return;
          this.accept(id, instance, body.sessions);
        } catch { /* Transient disconnects must not create or clear a human-input request. */ }
      }));
    } finally { this.polling = false; }
  }
  private accept(projectId: string, instance: Instance, sessions: AttentionSession[]): void {
    const now = Date.now();
    const pending = sessions.filter(s => s.agentRole === 'director' && s.status === 'running' &&
      typeof s.id === 'string' && typeof s.agentId === 'string' && typeof s.attention?.id === 'string' &&
      ['input', 'permission'].includes(s.attention.kind) && Number.isFinite(Date.parse(s.attention.since)));
    this.manager.setNeedsInput(projectId, pending.length > 0);
    const liveKeys = new Set(sessions.map(s => `${projectId}/${instance.instanceId}/${s.id}/`));
    for (const key of this.seen.keys()) if (key.startsWith(projectId + '/') && !liveKeys.has(key)) this.seen.delete(key);
    for (const key of this.lastNotification.keys()) if (key.startsWith(projectId + '/') && !liveKeys.has(key)) this.lastNotification.delete(key);
    for (const session of pending) {
      const attention = session.attention!;
      const prefix = `${projectId}/${instance.instanceId}/${session.id}/`;
      if (this.seen.get(prefix) === attention.id || now - Date.parse(attention.since) < 5000 ||
          now - (this.lastNotification.get(prefix) ?? 0) < 60_000) continue;
      this.seen.set(prefix, attention.id); this.lastNotification.set(prefix, now);
      this.notify({ projectId, sessionId: session.id, agentId: session.agentId, attentionId: attention.id, kind: attention.kind });
    }
  }
}
