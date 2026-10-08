/** Binary min-heap of (node, priority) pairs. Duplicates are allowed; callers skip stale pops. */
export class MinHeap {
  private readonly nodes: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  peekPriority(): number {
    return this.priorities[0] ?? Infinity;
  }

  push(node: number, priority: number): void {
    let i = this.nodes.length;
    this.nodes.push(node);
    this.priorities.push(priority);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent]! <= priority) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { node: number; priority: number } | undefined {
    const n = this.nodes.length;
    if (n === 0) return undefined;
    const top = { node: this.nodes[0]!, priority: this.priorities[0]! };
    const lastNode = this.nodes.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (n > 1) {
      this.nodes[0] = lastNode;
      this.priorities[0] = lastPriority;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < n - 1 && this.priorities[left]! < this.priorities[smallest]!) smallest = left;
        if (right < n - 1 && this.priorities[right]! < this.priorities[smallest]!) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const node = this.nodes[a]!;
    this.nodes[a] = this.nodes[b]!;
    this.nodes[b] = node;
    const priority = this.priorities[a]!;
    this.priorities[a] = this.priorities[b]!;
    this.priorities[b] = priority;
  }
}
