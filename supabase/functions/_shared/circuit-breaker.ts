interface FailureRecord {
  count: number;
  lastFailure: number;
}

// In-memory and therefore per-isolate. Supabase runs many isolates and recycles
// them freely, so this trims obviously-dead providers out of a hot path within
// one isolate — it is not a cluster-wide breaker. Only transient failures are
// recorded (see `isTransientFailure`); configuration errors must not trip it.
const failureMap = new Map<string, FailureRecord>();

const FAILURE_THRESHOLD = 3;
const RECOVERY_TIME_MS = 5 * 60 * 1000;

export function isCircuitOpen(providerId: string): boolean {
  const record = failureMap.get(providerId);
  if (!record) return false;

  if (Date.now() - record.lastFailure > RECOVERY_TIME_MS) {
    failureMap.delete(providerId);
    return false;
  }

  return record.count >= FAILURE_THRESHOLD;
}

export function recordFailure(providerId: string): void {
  const record = failureMap.get(providerId) || { count: 0, lastFailure: 0 };
  record.count += 1;
  record.lastFailure = Date.now();
  failureMap.set(providerId, record);
}

export function recordSuccess(providerId: string): void {
  failureMap.delete(providerId);
}
