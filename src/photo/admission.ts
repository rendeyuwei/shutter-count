type Code = "parser_queue_full" | "parser_queue_timeout" | "parser_closed";
export class AdmissionError extends Error {
  constructor(public readonly code: Code) {
    super(code);
  }
}
interface Waiter {
  grant: () => void;
  reject: (code: Code) => void;
}

/** Bound the whole upload lifetime, including disk writes and cleanup. */
export class Admission {
  private active = 0;
  private closed = false;
  private readonly queue: Waiter[] = [];
  constructor(
    private readonly capacity: number,
    private readonly waiting: number,
    private readonly waitMs: number
  ) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed || signal?.aborted)
      throw new AdmissionError("parser_closed");
    if (this.active < this.capacity) {
      this.active++;
      return this.releaseOnce();
    }
    if (this.queue.length >= this.waiting)
      throw new AdmissionError("parser_queue_full");
    return new Promise((resolve, reject) => {
      const remove = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const waiter: Waiter = {
        grant: () => {
          remove();
          this.active++;
          resolve(this.releaseOnce());
        },
        reject: (code) => {
          remove();
          reject(new AdmissionError(code));
        },
      };
      const abort = () => waiter.reject("parser_closed");
      const timer = setTimeout(
        () => waiter.reject("parser_queue_timeout"),
        this.waitMs
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (!this.closed) this.queue[0]?.grant();
    };
  }
  close(): void {
    this.closed = true;
    for (const waiter of [...this.queue]) waiter.reject("parser_closed");
  }
}
