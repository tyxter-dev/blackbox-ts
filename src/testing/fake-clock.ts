export interface Clock {
  now(): Date;
  nowMs(): number;
  sleep(milliseconds: number): Promise<void>;
}

interface Waiter {
  readonly target: number;
  readonly resolve: () => void;
}

export class FakeClock implements Clock {
  private current: number;
  private readonly waiters: Waiter[] = [];

  constructor(start: string | number | Date = 0) {
    this.current = start instanceof Date ? start.getTime() : new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  nowMs(): number {
    return this.current;
  }

  sleep(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ target: this.current + milliseconds, resolve });
    });
  }

  advance(milliseconds: number): void {
    if (milliseconds < 0) throw new RangeError('FakeClock cannot move backwards.');
    this.current += milliseconds;
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter !== undefined && waiter.target <= this.current) {
        this.waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}
