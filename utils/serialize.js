/**
 * Creates a promise-chain lock: calls run strictly one at a time, FIFO.
 * Shared by the log store and both modem drivers — the modem and the log
 * file are single-process resources.
 */
module.exports = function createSerializer() {
  let chain = Promise.resolve();
  return function withLock(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
};
