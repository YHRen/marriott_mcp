/**
 * Strider Labs - Browser Mutex
 *
 * Serializes browser operations to prevent concurrent access
 * to the singleton Playwright page. MCP can dispatch multiple
 * tool calls concurrently; this ensures they execute one at a time.
 */

/**
 * A simple async mutex (mutual exclusion lock).
 * Operations call `acquire()` before using the browser and
 * `release()` when done. If the lock is held, callers queue
 * up and are processed in FIFO order.
 */
export class BrowserMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  /**
   * Acquire the lock. Resolves immediately if unlocked,
   * otherwise waits until the current holder releases.
   */
  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release the lock. If there are queued waiters,
   * the next one in line is woken up.
   */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Pass the lock to the next waiter (lock stays held)
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * Helper: run a function while holding the mutex.
 * Ensures the lock is always released, even on error.
 */
export async function withMutex<T>(
  mutex: BrowserMutex,
  fn: () => Promise<T>
): Promise<T> {
  await mutex.acquire();
  try {
    return await fn();
  } finally {
    mutex.release();
  }
}
