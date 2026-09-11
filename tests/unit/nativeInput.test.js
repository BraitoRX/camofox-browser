import { jest } from '@jest/globals';
import { withNativeInput, createStallRecovery } from '../../lib/native-input.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withNativeInput', () => {
  test('serializes overlapping tasks and propagates results', async () => {
    const events = [];

    const first = withNativeInput(async () => {
      events.push('first:start');
      await delay(30);
      events.push('first:end');
      return 'first-result';
    });
    const second = withNativeInput(async () => {
      events.push('second:start');
      await delay(5);
      events.push('second:end');
      return 'second-result';
    });

    await expect(first).resolves.toBe('first-result');
    await expect(second).resolves.toBe('second-result');
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  test('a rejected task does not break the chain', async () => {
    const events = [];

    const failing = withNativeInput(async () => {
      events.push('failing:start');
      throw new Error('boom');
    });
    const following = withNativeInput(async () => {
      events.push('following:start');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
    expect(events).toEqual(['failing:start', 'following:start']);
  });
});

describe('createStallRecovery', () => {
  test('probe resolves -> no restart', async () => {
    const restartBrowser = jest.fn(async () => {});
    const recovery = createStallRecovery({ restartBrowser, probeTimeoutMs: 50 });

    const result = await recovery.afterNativeInputTimeout({
      probe: async () => {},
      meta: { tabId: 'tab-a' },
    });

    expect(result).toEqual({ probed: true, wedged: false });
    expect(restartBrowser).not.toHaveBeenCalled();
  });

  test('probe timeout -> wedged, and two concurrent stalls restart exactly once', async () => {
    const restartBrowser = jest.fn(async () => {});
    const logs = [];
    const log = (level, msg, fields = {}) => logs.push({ level, msg, fields });
    const recovery = createStallRecovery({
      restartBrowser,
      log,
      probeTimeoutMs: 25,
      restartCooldownMs: 60000,
    });

    const neverSettles = () => new Promise(() => {});
    const [first, second] = await Promise.all([
      recovery.afterNativeInputTimeout({ probe: neverSettles, meta: { tabId: 'tab-a' } }),
      recovery.afterNativeInputTimeout({ probe: neverSettles, meta: { tabId: 'tab-b' } }),
    ]);

    expect(first).toEqual({ probed: true, wedged: true });
    expect(second).toEqual({ probed: true, wedged: true });
    expect(restartBrowser).toHaveBeenCalledTimes(1);
    expect(restartBrowser).toHaveBeenCalledWith('input_stall');
    // The probe uses its own exact timeout label.
    expect(logs.some((entry) => entry.fields.error === 'input pipeline probe timed out after 25ms')).toBe(true);
  });

  test('non-timeout probe rejection -> not wedged, no restart', async () => {
    const restartBrowser = jest.fn(async () => {});
    const recovery = createStallRecovery({ restartBrowser, probeTimeoutMs: 50 });
    const failure = new Error('Target closed');

    const result = await recovery.afterNativeInputTimeout({
      probe: async () => { throw failure; },
      meta: { tabId: 'tab-a' },
    });

    expect(result.probed).toBe(true);
    expect(result.wedged).toBe(false);
    expect(result.error).toBe(failure);
    expect(restartBrowser).not.toHaveBeenCalled();
  });
});
