// One browser job at a time: every job drives Playwright on a personal
// machine, and a user's Chromium profile must never be opened twice at once.
export function createQueue() {
  let tail = Promise.resolve();
  let depth = 0;
  return {
    push(job) {
      depth += 1;
      const run = tail.then(() => job());
      // Attached directly to `run` (not a derived chain) so the decrement
      // lands before any caller continuation that awaits the same promise;
      // the two-handler form avoids the unhandled rejection a .finally()
      // chain would create for rejected jobs.
      const settled = () => { depth -= 1; };
      run.then(settled, settled);
      tail = run.catch(() => {});
      return run;
    },
    size() {
      return depth;
    },
  };
}
