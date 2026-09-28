/** Serialize one key through the entire operation, including rollback. */
export class KeyedAsyncLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);
    if (prior) await prior;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
