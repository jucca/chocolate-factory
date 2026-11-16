import type { WorkerPort, WorkerReport, WorkerTask } from './ports.js';

export async function dispatchWorker(port: WorkerPort, task: WorkerTask): Promise<WorkerReport> {
  const report = await port.run(task);
  if (task.role === 'implement' && report.status === 'blocked' && report.notes.startsWith('spawn failed')) {
    const next = await port.run({ ...task, role: 'default' });
    return { ...next, route: 'default', fallback: `${task.unitId} implement→default (${report.notes})` };
  }
  return report;
}
