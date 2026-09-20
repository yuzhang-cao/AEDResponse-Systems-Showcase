/** Indexed heap: one live node per record, including after repeated rescheduling. */
export class DeadlineIndex {
  private readonly heap: { key: string; at: number; order: number }[] = [];
  private readonly positions = new Map<string, number>();
  private nextOrder = 0;

  get size(): number { return this.heap.length; }

  upsert(key: string, at: number): void {
    const existing = this.positions.get(key);
    const order = existing === undefined ? this.nextOrder++ : this.heap[existing]!.order;
    this.remove(key);
    this.positions.set(key, this.heap.length);
    this.heap.push({ key, at, order });
    this.up(this.heap.length - 1);
  }

  remove(key: string): void {
    const index = this.positions.get(key);
    if (index === undefined) return;
    this.positions.delete(key);
    const last = this.heap.pop()!;
    if (index === this.heap.length) return;
    this.heap[index] = last;
    this.positions.set(last.key, index);
    this.down(this.up(index));
  }

  /** Non-destructive: a failed dispatch/commit must not consume a durable due row. */
  due(at: number, limit: number): { keys: string[]; visited: number } {
    const pending = [0];
    const selected: typeof this.heap = [];
    let visited = 0;
    while (pending.length) {
      const index = pending.pop()!;
      const node = this.heap[index];
      if (!node) continue;
      visited += 1;
      if (node.at > at) continue;
      selected.push(node);
      pending.push(index * 2 + 1, index * 2 + 2);
    }
    // Preserve the old collection-order dispatch policy among due messages.
    selected.sort((a, b) => a.order - b.order);
    return { keys: selected.slice(0, limit).map(node => node.key), visited };
  }

  private swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b]!, this.heap[a]!];
    this.positions.set(this.heap[a]!.key, a);
    this.positions.set(this.heap[b]!.key, b);
  }
  private up(start: number): number {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.heap[parent]!.at <= this.heap[index]!.at) break;
      this.swap(parent, index);
      index = parent;
    }
    return index;
  }
  private down(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let least = index;
      if (left < this.heap.length && this.heap[left]!.at < this.heap[least]!.at) least = left;
      if (right < this.heap.length && this.heap[right]!.at < this.heap[least]!.at) least = right;
      if (least === index) return;
      this.swap(index, least);
      index = least;
    }
  }
}
