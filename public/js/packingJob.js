/** Run CPU-heavy packing off the UI thread. Every exit terminates the worker. */
export function startPacking(catalog, options, timeoutMs = 10000) {
  const worker = new Worker(new URL('./autoload.worker.js', import.meta.url), { type: 'module' });
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Packing timed out. Reduce the catalog or search depth.')), timeoutMs);
    cancel = () => finish(new Error('Packing cancelled'));
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
    worker.onerror = () => finish(new Error('Packing worker failed. Please retry.'));
    try { worker.postMessage({ catalog, options }); }
    catch (error) { finish(error); }
  });
  return { promise, cancel: () => cancel() };
}