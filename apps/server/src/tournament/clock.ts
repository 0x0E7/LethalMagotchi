export interface Timer {
  cancel(): void;
}

/**
 * The one seam every deadline in the tournament goes through, so a test can drive a
 * 20-second turn without sleeping for 20 seconds.
 */
export interface Clock {
  now(): number;
  after(ms: number, run: () => void): Timer;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const handle = setTimeout(run, ms);
    // A pending turn deadline must never be the reason a process refuses to exit.
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  },
};
