// Test double for the installed session-owned jobs contract; no host jobs.
export function fakeJobs() {
  const records = new Map();
  return {
    records,
    list(owner) { return [...records.values()].filter(job => job.owner === owner).map(({id,owner,status}) => ({id,owner,status})); },
    start(spec) {
      const id = `workflow-test-${records.size + 1}`;
      const record = { id, owner: spec.owner, status: 'running', lines: [], progress: [] };
      const hooks = spec.run({ id, append: text => record.lines.push(text), updateProgress: text => record.progress.push(text) });
      record.hooks = hooks;
      record.done = Promise.resolve(hooks.done).then(outcome => { record.status = outcome.status; record.outcome = outcome; return outcome; });
      records.set(id, record);
      return id;
    },
    kill(id, owner, reason) {
      const record = records.get(id);
      if (!record || record.owner !== owner) throw new Error('job owner mismatch');
      record.hooks.cancel(reason);
    },
    async settle(id) { return records.get(id)?.done; },
    async settleAll() { await Promise.all([...records.values()].map(record => record.done)); },
  };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
