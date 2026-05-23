import { Langfuse, type LangfuseTraceClient } from "langfuse";

// Optional tracing. If LANGFUSE_PUBLIC_KEY isn't set, every call here no-ops
// — production code stays clean and works whether or not LangFuse is wired up.

let _client: Langfuse | null | undefined = undefined; // undefined = not checked yet

function client(): Langfuse | null {
  if (_client !== undefined) return _client;
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  const host = process.env.LANGFUSE_BASE_URL;
  if (!pk || !sk) {
    _client = null;
    return null;
  }
  _client = new Langfuse({
    publicKey: pk,
    secretKey: sk,
    baseUrl: host,
  });
  return _client;
}

export type Trace = LangfuseTraceClient | null;

export function trace(opts: {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
}): Trace {
  return client()?.trace(opts) ?? null;
}

// Wait for queued events to flush. Call before process exit (CLI scripts) or
// at the end of a request so events actually reach the server.
export async function flush(): Promise<void> {
  await client()?.flushAsync();
}
