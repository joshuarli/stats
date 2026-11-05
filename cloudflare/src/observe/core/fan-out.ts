export async function awaitEvery(deliveries: readonly Promise<void>[]): Promise<void> {
  const failures = (await Promise.allSettled(deliveries)).flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "observe delivery failed for several services");
}
