import { AgentMeterError } from "./errors";

/**
 * Race a call against a deadline. Adapters use it for every external call (TRD §3.1).
 * The optional AbortController is aborted on timeout so fetch-style calls actually stop.
 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new AgentMeterError("TIMEOUT", `${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(ctrl.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
