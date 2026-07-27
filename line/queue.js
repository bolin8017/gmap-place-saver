// One browser job at a time: every job drives Playwright on a personal
// machine, and a user's Chromium profile must never be opened twice at once.
export function createQueue() {
  let tail = Promise.resolve();
  let depth = 0;
  return {
    push(job) {
      depth += 1;
      const run = tail.then(job);
      tail = run.catch(() => {}).finally(() => { depth -= 1; });
      return run;
    },
    size() {
      return depth;
    },
  };
}
