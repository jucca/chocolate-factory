export class RunWalker {
  private active = new Set<string>();
  constructor(private runs: { advance(runId: string): Promise<unknown> }) {}
  kick(runId: string): void {
    if (this.active.has(runId)) return;
    this.active.add(runId);
    void this.runs.advance(runId).finally(() => { this.active.delete(runId); }).catch(() => {});
  }
}
