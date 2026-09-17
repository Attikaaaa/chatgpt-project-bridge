/**
 * Mutual-exclusion queue. All browser access goes through one of these so
 * HTTP requests can never interleave browser actions.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve()

  /** Run fn exclusively; queued in arrival order. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    // keep the chain alive regardless of fn's outcome
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Drain helper for tests/shutdown. */
  settled(): Promise<void> {
    return this.tail
  }
}
