// Browser-wide native mouse input serialization and input-stall recovery.
//
// WHAT THIS IS
//   A module-level FIFO gate (`withNativeInput`) that serializes native mouse
//   input dispatch for the single shared browser process, plus a stall probe
//   (`createStallRecovery`) that detects a wedged Playwright input pipeline
//   and asks the server to restart the browser.
//
// WHY SERIALIZATION
//   The server already serializes work per tab (`withTabLock`), but every tab
//   shares one browser process and one Playwright driver connection. Native
//   input (`page.mouse.*`) is dispatched over that single connection, so a call
//   that never settles -- observed as a ~28s timeout followed by tab
//   destruction -- leaves the shared input pipeline wedged: every subsequent
//   native input op across all tabs and users hangs until the browser is
//   manually restarted. Serializing dispatch cannot make an already-wedged
//   call settle, but it stops the server from feeding more concurrent input
//   into a wedged pipeline and gives the stall probe a single, well-ordered
//   observation point.
//
// RECOVERY
//   `dispatchNativeInput` in server.js catches native-input timeouts and calls
//   `afterNativeInputTimeout`, which runs a small probe (e.g. a mouse move)
//   through the same gate:
//     - probe resolves         -> the pipeline recovered on its own; no restart.
//     - probe rejects otherwise -> the tab/page died (e.g. Target closed),
//                                  which is not a shared-pipeline stall; no restart.
//     - probe times out         -> a single timeout can be a busy page rather
//                                  than a wedged pipeline: the probe must time
//                                  out on `wedgeConfirmations` consecutive
//                                  attempts before the pipeline is considered
//                                  wedged. A restart is then scheduled
//                                  fire-and-forget and deduped by a cooldown so
//                                  concurrent stalls trigger one restart.
//
// ERRORS
//   Errors never break the serialization chain: a rejected task releases the
//   gate for the next queued task, and the rejection propagates only to the
//   caller that submitted it. This module performs no I/O and no process
//   control of its own -- the server supplies `restartBrowser` and `log`.

// Module-level FIFO gate: one chain for the single shared browser.
let inputChain = Promise.resolve();

/**
 * Run `task` after every previously submitted native input task has settled.
 * Returns a promise for this task's own result. A rejection is isolated to the
 * caller: the chain itself always continues with the next queued task.
 */
export function withNativeInput(task) {
  const result = inputChain.then(() => task());
  // Swallow both outcomes on the chain copy so one failure never wedges the
  // queue; `result` still carries the real outcome to the caller.
  inputChain = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Create the input-stall recovery helper used by `dispatchNativeInput`.
 *
 * @param {object} options
 * @param {(reason: string) => Promise<unknown>} options.restartBrowser
 *   Server recovery entry point (fire-and-forget from here).
 * @param {Function} [options.log] Structured `log(level, msg, fields)` sink.
 * @param {number} [options.probeTimeoutMs] Bound for the liveness probe.
 * @param {number} [options.restartCooldownMs] Dedup window for restarts.
 * @param {number} [options.wedgeConfirmations] Consecutive timed-out probes
 *   required before a restart is scheduled.
 */
export function createStallRecovery({
  restartBrowser,
  log = () => {},
  probeTimeoutMs = 4000,
  restartCooldownMs = 30000,
  wedgeConfirmations = 2,
} = {}) {
  if (typeof restartBrowser !== 'function') {
    throw new TypeError('createStallRecovery requires a restartBrowser function');
  }

  let lastRestartAt = 0;

  /**
   * Decide whether a native-input timeout means the shared input pipeline is
   * wedged, and schedule a browser restart when it is. The probe runs through
   * the same FIFO gate with its own bounded timeout label, so it can only
   * observe the pipeline after the timed-out operation released the gate.
   */
  async function afterNativeInputTimeout({ probe, meta = {} } = {}) {
    if (typeof probe !== 'function') {
      return { probed: false, wedged: false };
    }

    const label = 'input pipeline probe';
    const timeoutError = new Error(`${label} timed out after ${probeTimeoutMs}ms`);
    const runProbe = () => {
      let timer = null;
      return withNativeInput(() => new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError), probeTimeoutMs);
        Promise.resolve()
          .then(() => probe())
          .then(resolve, reject);
      })).finally(() => { if (timer) clearTimeout(timer); });
    };

    // One probe timeout can be a busy page rather than a wedged pipeline, and a
    // browser restart destroys every live tab. Confirm across consecutive probes.
    let wedges = 0;
    for (let attempt = 0; attempt < Math.max(1, wedgeConfirmations); attempt++) {
      try {
        await runProbe();
        log('warn', 'native input probe completed after timeout', { ...meta, outcome: 'pipeline-alive', attempt: attempt + 1 });
        return { probed: true, wedged: false };
      } catch (err) {
        if (err !== timeoutError) {
          log('warn', 'native input probe failed after timeout', { ...meta, error: err && err.message });
          return { probed: true, wedged: false, error: err };
        }
        wedges += 1;
      }
    }

    const now = Date.now();
    if (now - lastRestartAt >= restartCooldownMs) {
      lastRestartAt = now;
      log('warn', 'native input pipeline wedged, restarting browser', {
        ...meta,
        reason: 'input_stall',
        confirmations: wedges,
      });
      try {
        const restartPromise = restartBrowser('input_stall');
        if (restartPromise && typeof restartPromise.catch === 'function') {
          restartPromise.catch((restartErr) => {
            log('error', 'input stall browser restart failed', { error: restartErr && restartErr.message });
          });
        }
      } catch (restartErr) {
        log('error', 'input stall browser restart failed', { error: restartErr && restartErr.message });
      }
    } else {
      log('warn', 'native input pipeline wedged, restart already scheduled', { ...meta, reason: 'input_stall' });
    }
    return { probed: true, wedged: true };
  }

  return { afterNativeInputTimeout };
}
