import { execFileSync } from 'node:child_process';
import type { Plugin } from 'vite';

// Resolve the build's commit hash. Prefer an explicit env override (handy for
// Docker builds where the build context has no .git), fall back to `git`, and
// finally to a placeholder so the build never fails when git is unavailable.
const resolveCommitHash = (): string => {
  // biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket access under TS noPropertyAccessFromIndexSignature
  const override = process.env['COMMIT_HASH'];
  if (override) return override;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'unknown';
  }
};

const plugin = (): Plugin => ({
  name: 'commit-hash',
  config: () => ({
    define: {
      COMMIT_HASH: JSON.stringify(resolveCommitHash())
    }
  })
});
export default plugin;
