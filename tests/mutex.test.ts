/**
 * Tests for the browser mutex module.
 *
 * Verifies that concurrent operations are serialized properly.
 */

import { describe, it, expect } from "vitest";
import { BrowserMutex, withMutex } from "../src/mutex.js";

describe("BrowserMutex", () => {
  it("allows immediate acquisition when unlocked", async () => {
    const mutex = new BrowserMutex();
    await mutex.acquire(); // Should resolve immediately
    mutex.release();
  });

  it("serializes concurrent operations", async () => {
    const mutex = new BrowserMutex();
    const order: number[] = [];

    const task = async (id: number, delay: number) => {
      await mutex.acquire();
      // Simulate async work
      await new Promise((r) => setTimeout(r, delay));
      order.push(id);
      mutex.release();
    };

    // Start three tasks concurrently
    await Promise.all([
      task(1, 30),
      task(2, 10),
      task(3, 10),
    ]);

    // Tasks should execute in order (1 acquires first, then 2, then 3)
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("withMutex", () => {
  it("returns the function result", async () => {
    const mutex = new BrowserMutex();
    const result = await withMutex(mutex, async () => 42);
    expect(result).toBe(42);
  });

  it("releases the lock even on error", async () => {
    const mutex = new BrowserMutex();

    // This should fail but release the lock
    await expect(
      withMutex(mutex, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // Lock should be available for next caller
    let acquired = false;
    await withMutex(mutex, async () => {
      acquired = true;
    });
    expect(acquired).toBe(true);
  });

  it("prevents concurrent execution", async () => {
    const mutex = new BrowserMutex();
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      await withMutex(mutex, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
      });
    };

    await Promise.all([task(), task(), task(), task()]);
    expect(maxConcurrent).toBe(1);
  });
});
