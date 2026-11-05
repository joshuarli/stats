export interface Clock {
  now(): number;
}

export interface Scheduler {
  pending(): Promise<number | null>;
  at(atMs: number): Promise<void>;
}
