import { stampRepo } from '../src/stamp/stamp.js';

const [cmd, repoRoot] = process.argv.slice(2);
if (cmd === 'stamp' && repoRoot) {
  const { created } = stampRepo(repoRoot);
  console.log(`stamped ${repoRoot}: ${created.length} paths created`);
} else if (cmd === 'serve') {
  const { startServer } = await import('../src/server/server.js');
  await startServer(repoRoot ?? process.cwd());
} else {
  console.error('usage: chocolate stamp <repoRoot> | chocolate serve <repoRoot>');
  process.exit(1);
}
