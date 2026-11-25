import type { Network } from './network';

export type EdgeCost = (edgeId: number) => number;

/** Free-flow edge cost in seconds, with a delay penalty for passing through a junction at the edge's end. */
export function freeFlowCost(net: Network): EdgeCost {
  return (id) => {
    const e = net.edges[id];
    const node = net.nodes.get(e.to)!;
    const junction = node.isEndpoint ? 0 : node.signal ? 12 : 3;
    return e.length / Math.max(1, e.speedLimit) + junction;
  };
}

/**
 * Dijkstra over directed edges from `fromEdge` to any edge arriving at `destNode`.
 * Returns the edge sequence (including fromEdge) or null when unreachable.
 */
export function shortestRoute(net: Network, fromEdge: number, destNode: string, cost: EdgeCost): number[] | null {
  const n = net.edges.length;
  const best = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  best[fromEdge] = cost(fromEdge);
  // Binary heap of [cost, edge]
  const heap: [number, number][] = [[best[fromEdge], fromEdge]];
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length > 0) {
    const [c, e] = pop();
    if (done[e]) continue;
    done[e] = 1;
    if (net.edges[e].to === destNode) {
      const route: number[] = [];
      for (let cur = e; cur !== -1; cur = prev[cur]) route.push(cur);
      return route.reverse();
    }
    for (const nx of net.edges[e].next) {
      const nc = c + cost(nx);
      if (nc < best[nx]) {
        best[nx] = nc;
        prev[nx] = e;
        push([nc, nx]);
      }
    }
  }
  return null;
}

/** Endpoint nodes reachable from an entry edge (used for "any destination" flows and validation). */
export function reachableExits(net: Network, fromEdge: number): string[] {
  const seen = new Set<number>([fromEdge]);
  const stack = [fromEdge];
  const exits = new Set<string>();
  while (stack.length) {
    const e = stack.pop()!;
    const edge = net.edges[e];
    if (net.nodes.get(edge.to)!.isEndpoint) exits.add(edge.to);
    for (const nx of edge.next) {
      if (!seen.has(nx)) {
        seen.add(nx);
        stack.push(nx);
      }
    }
  }
  return [...exits].sort();
}
