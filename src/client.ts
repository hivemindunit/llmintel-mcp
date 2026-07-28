/**
 * Minimal client for the public LLMIntel catalog API.
 *
 * The catalog endpoints require no API key, which is the whole point of this server: an agent can
 * answer "is this model deprecated?" with zero setup. A key is accepted anyway (via
 * `LLMINTEL_API_KEY`) purely to raise the rate-limit budget for heavy users.
 */

export const DEFAULT_BASE_URL = "https://llmintel.ai";

/** Canonical lifecycle states, ordered from earliest to latest in a model's life. */
export const LIFECYCLE_STATES = [
  "announced",
  "active",
  "legacy",
  "deprecated",
  "retiring",
  "retired",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const PROVIDERS = [
  "openai",
  "anthropic",
  "azure",
  "bedrock",
  "google",
  "cohere",
  "mistral",
] as const;

export type Provider = (typeof PROVIDERS)[number];

export interface ModelSummary {
  id: string;
  provider: string;
  displayName: string;
  aliases?: string[];
  lifecycleState: LifecycleState;
  announcedDate: string | null;
  deprecatedDate: string | null;
  retirementDate: string | null;
  sourceUrl: string | null;
  sourceTerm?: string | null;
}

export interface ModelSpec {
  inputUsdPerMillion?: number | null;
  outputUsdPerMillion?: number | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}

export interface ModelDetail extends ModelSummary {
  spec?: ModelSpec | null;
  migration?: {
    recommendedReplacementIds?: string[];
    resolvedReplacements?: Record<string, string>;
    breakingNotes?: string | null;
    confidence?: string | null;
  } | null;
  events?: Array<{
    fromState: LifecycleState | null;
    toState: LifecycleState;
    detectedAt: string;
  }>;
}

export interface LifecycleEvent {
  modelId: string;
  provider: string;
  fromState: LifecycleState | null;
  toState: LifecycleState;
  detectedAt: string;
  sourceUrl?: string | null;
}

/** Thrown for any non-2xx catalog response, carrying the HTTP status for the caller to interpret. */
export class CatalogError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
  }
}

/**
 * The catalog reads the MCP tools depend on.
 *
 * `CatalogClient` is the implementation that talks to the public REST API, and it is what the npm
 * package ships. Keeping the tools on a structural interface lets llmintel.ai serve the same tools
 * over Streamable HTTP while reading its own database directly, instead of the deployment issuing
 * HTTP calls to itself and burning its own anonymous per-IP rate limit on behalf of every caller.
 */
export interface CatalogSource {
  getModel(ref: string): Promise<ModelDetail | null>;
  listModels(params?: {
    provider?: string;
    state?: string;
    limit?: number;
    offset?: number;
  }): Promise<ModelSummary[]>;
  listEvents(params?: {
    provider?: string;
    state?: string;
    since?: string;
    limit?: number;
  }): Promise<LifecycleEvent[]>;
}

export interface CatalogClientOptions {
  baseUrl?: string;
  /** Optional — only raises the rate-limit budget. The catalog itself is public. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Abort a hung request so a stalled network never wedges the agent's tool call. */
  timeoutMs?: number;
}

export class CatalogClient implements CatalogSource {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CatalogClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url.toString(), { headers, signal });

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new CatalogError(response.status, body || response.statusText);
    }
    return (await response.json()) as T;
  }

  /**
   * Look up one model by canonical id *or* alias — `gpt-4o` works as well as
   * `openai/gpt-4o-2024-05-13`. Returns null when nothing matches, so callers can distinguish
   * "we don't track this" from a transport failure.
   */
  async getModel(ref: string): Promise<ModelDetail | null> {
    // The id may contain slashes; encode each segment so the catch-all route reassembles it.
    const encoded = ref
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    try {
      const body = await this.get<{ data: ModelDetail }>(`/v1/models/${encoded}`);
      return body.data;
    } catch (error) {
      if (error instanceof CatalogError && error.status === 404) return null;
      throw error;
    }
  }

  async listModels(
    params: { provider?: string; state?: string; limit?: number; offset?: number } = {},
  ): Promise<ModelSummary[]> {
    const body = await this.get<{ data: ModelSummary[] }>("/v1/models", params);
    return body.data ?? [];
  }

  async listEvents(
    params: { provider?: string; state?: string; since?: string; limit?: number } = {},
  ): Promise<LifecycleEvent[]> {
    const body = await this.get<{ data: LifecycleEvent[] }>("/v1/events", params);
    return body.data ?? [];
  }
}
