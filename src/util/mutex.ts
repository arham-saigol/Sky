export class KeyedMutex {
  private readonly queues = new Map<string, Promise<void>>();

  public async runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    this.queues.set(key, tail);
    await prior;
    try {
      return await work();
    } finally {
      release?.();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }
}
