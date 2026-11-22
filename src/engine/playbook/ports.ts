export type WorkerRole = 'default' | 'implement';
export type WorkerStatus = 'done' | 'partial' | 'blocked';

export interface WorkerTask {
  role: WorkerRole;
  runDir: string;
  repoRoot: string;
  prompt: string;
  allowedFiles: string[];
  unitId: string;
}

export interface WorkerReport {
  status: WorkerStatus;
  filesChanged: string[];
  notes: string;
  route: WorkerRole;
  fallback?: string;
}

export interface WorkerPort {
  run(task: WorkerTask): Promise<WorkerReport>;
}

export interface CommandResult {
  ok: boolean;
  output: string;
}

export interface CommandRunner {
  run(repoRoot: string, command: string): Promise<CommandResult>;
}

export interface ToolboxGit {
  show(repoRoot: string, rev: string, path: string): Promise<string | null>;
  restoreTree(repoRoot: string, rev: string, path: string): Promise<void>;
}

export interface GitPort {
  isRepo(repoRoot: string): Promise<boolean>;
  statusPorcelain(repoRoot: string): Promise<string>;
  originHead(repoRoot: string): Promise<string | null>;
  fetch(repoRoot: string): Promise<void>;
  branchExists(repoRoot: string, name: string): Promise<boolean>;
  createBranch(repoRoot: string, name: string, from: string): Promise<void>;
  headBranch(repoRoot: string): Promise<string>;
  headSha(repoRoot: string): Promise<string>;
  commitAll(repoRoot: string, message: string): Promise<void>;
  diffNames(repoRoot: string, baseSha: string, pathspec?: string): Promise<string[]>;
  changedLines(repoRoot: string, baseSha: string): Promise<number>;
  push(repoRoot: string, branch: string): Promise<void>;
  remoteHead(repoRoot: string, branch: string): Promise<string | null>;
  revert(repoRoot: string, paths: string[]): Promise<void>;
  deleteUntracked(repoRoot: string, paths: string[]): Promise<void>;
}

export interface IssueText {
  title: string;
  body: string;
  comments: string[];
}

export interface PullRequestView {
  url: string;
  number: number;
  isDraft: boolean;
  headSha: string;
  headBranch: string;
}

export interface CheckView {
  name: string;
  state: string;
  bucket: string;
  link: string;
}

export interface ForgePort {
  defaultBranch(repo: string): Promise<string | null>;
  readIssue(repo: string, number: number): Promise<IssueText>;
  viewPr(repoRoot: string): Promise<PullRequestView | null>;
  upsertPr(input: { repoRoot: string; base: string; title: string; bodyPath: string; draft: boolean }): Promise<PullRequestView>;
  checks(repoRoot: string, prNumber: number): Promise<CheckView[]>;
  rerunFailed(repoRoot: string, runId: string): Promise<void>;
  failedLog(repoRoot: string, runId: string): Promise<string>;
}
