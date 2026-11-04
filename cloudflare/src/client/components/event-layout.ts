export interface EventCandidate {
  readonly x: number;
  readonly label: string;
  readonly short?: string | undefined;
}

export interface PlacedEvent {
  readonly x: number;
  readonly text: string | null;
  readonly side: "right" | "left";
  readonly count: number;
}

export interface EventSpacing {
  readonly minX: number;
  readonly maxX: number;
  readonly mergePx: number;
  readonly padPx: number;
}

interface Cluster {
  readonly x: number;
  readonly members: EventCandidate[];
}

function clusterOf(sorted: readonly EventCandidate[], mergePx: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const candidate of sorted) {
    const last = clusters.at(-1);
    if (last !== undefined && candidate.x - last.x <= mergePx) last.members.push(candidate);
    else clusters.push({ x: candidate.x, members: [candidate] });
  }
  return clusters;
}

function textsOf(cluster: Cluster): readonly string[] {
  const [only] = cluster.members;
  if (cluster.members.length === 1 && only !== undefined) return only.short === undefined ? [only.label] : [only.label, only.short];
  return [`${cluster.members.length} deploys`, String(cluster.members.length)];
}

/**
 * Lines within `mergePx` collapse into one marker. A marker is labelled with the longest text that fits
 * between its line and the next line, else the same text to the left of its line, else not at all.
 */
export function placeEvents(candidates: readonly EventCandidate[], measure: (text: string) => number, spacing: EventSpacing): PlacedEvent[] {
  const sorted = candidates.filter(candidate => candidate.x >= spacing.minX && candidate.x <= spacing.maxX).sort((a, b) => a.x - b.x);
  const clusters = clusterOf(sorted, spacing.mergePx);
  const placed: PlacedEvent[] = [];
  let occupiedUntil = spacing.minX;
  for (const [index, cluster] of clusters.entries()) {
    const texts = textsOf(cluster);
    const rightRoom = (clusters[index + 1]?.x ?? spacing.maxX) - cluster.x - 2 * spacing.padPx;
    const leftRoom = cluster.x - occupiedUntil - 2 * spacing.padPx;
    const right = texts.find(text => measure(text) <= rightRoom);
    const left = right === undefined ? texts.find(text => measure(text) <= leftRoom) : undefined;
    const count = cluster.members.length;
    if (right !== undefined) {
      placed.push({ x: cluster.x, text: right, side: "right", count });
      occupiedUntil = cluster.x + spacing.padPx + measure(right);
    } else if (left !== undefined) {
      placed.push({ x: cluster.x, text: left, side: "left", count });
      occupiedUntil = cluster.x;
    } else {
      placed.push({ x: cluster.x, text: null, side: "right", count });
      occupiedUntil = Math.max(occupiedUntil, cluster.x);
    }
  }
  return placed;
}
