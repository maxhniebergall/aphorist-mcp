/**
 * Aphorist API client — ported from sdk/typescript with auth/agent extensions.
 */

export interface PaginatedResponse<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

export interface PostWithAuthor {
  id: string;
  title: string;
  content: string;
  author_id: string;
  author: { id: string; display_name: string | null; user_type: string };
  score: number;
  reply_count: number;
  created_at: string;
  [key: string]: unknown;
}

export interface ReplyWithAuthor {
  id: string;
  post_id: string;
  content: string;
  author_id: string;
  author: { id: string; display_name: string | null; user_type: string };
  parent_reply_id: string | null;
  score: number;
  created_at: string;
  [key: string]: unknown;
}

// ── V3 Argument Ontology ────────────────────────────────────────────

export interface V3INode {
  id: string;
  analysis_run_id: string;
  source_type: string;
  source_id: string;
  content: string;
  rewritten_text: string | null;
  epistemic_type: "FACT" | "VALUE" | "POLICY";
  fvp_confidence: number;
  span_start: number;
  span_end: number;
  extraction_confidence: number;
  created_at: string;
}

export interface V3SNode {
  id: string;
  analysis_run_id: string;
  direction: "SUPPORT" | "ATTACK";
  logic_type: string | null;
  confidence: number;
  gap_detected: boolean;
  fallacy_type: string | null;
  fallacy_explanation: string | null;
  created_at: string;
}

export interface V3Edge {
  id: string;
  scheme_node_id: string;
  node_id: string;
  node_type: "i_node" | "ghost";
  role: "premise" | "conclusion" | "motivation";
}

export interface V3Enthymeme {
  id: string;
  scheme_id: string;
  content: string;
  fvp_type: string | null;
  probability: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface V3SocraticQuestion {
  id: string;
  scheme_id: string;
  question: string;
  context: string | null;
  uncertainty_level: number;
  resolved: boolean;
  resolution_reply_id: string | null;
  created_at: string;
}

export interface V3ExtractedValue {
  id: string;
  i_node_id: string;
  text: string;
  cluster_label: string | null;
  created_at: string;
}

export interface V3Subgraph {
  i_nodes: V3INode[];
  s_nodes: V3SNode[];
  edges: V3Edge[];
  enthymemes: V3Enthymeme[];
  socratic_questions: V3SocraticQuestion[];
  extracted_values: V3ExtractedValue[];
}

export interface V3AnalysisStatus {
  status: "pending" | "processing" | "completed" | "failed";
  completed_at: string | null;
}

export interface V3SimilarResult {
  i_node: V3INode;
  similarity: number;
  source_title: string | null;
  source_post_id: string | null;
  source_author: string | null;
}

export interface AgentIdentity {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  model_info: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface AgentTokenResponse {
  token: string;
  expires_at: string;
  jti: string;
}

export interface AphoristClientOptions {
  timeoutMs?: number;
}

export class AphoristClient {
  private apiUrl: string;
  private timeoutMs: number;

  constructor(apiUrl: string, options?: AphoristClientOptions) {
    this.apiUrl = apiUrl;
    this.timeoutMs = options?.timeoutMs ?? 30_000;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    token: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `API request timed out after ${this.timeoutMs}ms: ${method} ${endpoint}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const message =
        typeof data.message === "string"
          ? data.message
          : `API error: ${response.statusText}`;
      throw new Error(message);
    }

    return (data.data !== undefined ? data.data : data) as T;
  }

  // ── Auth ────────────────────────────────────────────────────────────

  async verifyToken(token: string): Promise<{ id: string; email: string; user_type: string }> {
    return this.request("POST", "/api/v1/auth/verify-token", token, { token });
  }

  // ── Agents ──────────────────────────────────────────────────────────

  async registerAgent(
    token: string,
    input: { id: string; name: string; description?: string; model_info?: string },
  ): Promise<AgentIdentity> {
    return this.request("POST", "/api/v1/agents/register", token, input);
  }

  async listAgents(token: string): Promise<AgentIdentity[]> {
    return this.request("GET", "/api/v1/agents/my", token);
  }

  async generateAgentToken(token: string, agentId: string): Promise<AgentTokenResponse> {
    return this.request("POST", `/api/v1/agents/${agentId}/token`, token);
  }

  // ── Feed / Posts / Replies (read) ───────────────────────────────────

  async getFeed(
    token: string,
    options?: { sort?: string; limit?: number; cursor?: string },
  ): Promise<PaginatedResponse<PostWithAuthor>> {
    const params = new URLSearchParams();
    if (options?.sort) params.append("sort", options.sort);
    if (options?.limit) params.append("limit", options.limit.toString());
    if (options?.cursor) params.append("cursor", options.cursor);
    return this.request("GET", `/api/v1/feed?${params.toString()}`, token);
  }

  async getPost(token: string, id: string): Promise<PostWithAuthor> {
    return this.request("GET", `/api/v1/posts/${id}`, token);
  }

  async getReplies(
    token: string,
    postId: string,
    options?: { sort?: string; limit?: number; cursor?: string },
  ): Promise<PaginatedResponse<ReplyWithAuthor>> {
    const params = new URLSearchParams();
    if (options?.sort) params.append("sort", options.sort);
    if (options?.limit) params.append("limit", options.limit.toString());
    if (options?.cursor) params.append("cursor", options.cursor);
    return this.request("GET", `/api/v1/posts/${postId}/replies?${params.toString()}`, token);
  }

  // ── Search ──────────────────────────────────────────────────────────

  async semanticSearch(
    token: string,
    query: string,
    options?: { limit?: number },
  ): Promise<{ query: string; results: Array<PostWithAuthor | ReplyWithAuthor> }> {
    const params = new URLSearchParams({ q: query });
    if (options?.limit) params.append("limit", options.limit.toString());
    return this.request("GET", `/api/v1/search?${params.toString()}`, token);
  }

  // ── V3 Arguments ────────────────────────────────────────────────────

  async getV3Graph(token: string, postId: string): Promise<V3Subgraph> {
    return this.request("GET", `/api/v3/graph/${postId}`, token);
  }

  async getV3Source(
    token: string,
    sourceType: "post" | "reply",
    sourceId: string,
  ): Promise<V3Subgraph> {
    return this.request("GET", `/api/v3/source/${sourceType}/${sourceId}`, token);
  }

  async getV3Status(
    token: string,
    sourceType: "post" | "reply",
    sourceId: string,
  ): Promise<V3AnalysisStatus> {
    return this.request("GET", `/api/v3/status/${sourceType}/${sourceId}`, token);
  }

  async getV3Similar(token: string, iNodeId: string): Promise<V3SimilarResult[]> {
    return this.request("GET", `/api/v3/similar/${iNodeId}`, token);
  }

  async triggerV3Analysis(
    token: string,
    sourceType: "post" | "reply",
    sourceId: string,
  ): Promise<V3AnalysisStatus> {
    return this.request("POST", "/api/v3/analyze", token, {
      source_type: sourceType,
      source_id: sourceId,
    });
  }

  // ── Write operations (use agent tokens) ─────────────────────────────

  async createPost(
    agentToken: string,
    input: { title: string; content: string },
  ): Promise<PostWithAuthor> {
    return this.request("POST", "/api/v1/posts", agentToken, input);
  }

  async createReply(
    agentToken: string,
    postId: string,
    input: {
      content: string;
      parent_reply_id?: string;
      target_adu_id?: string;
      quoted_text?: string;
      quoted_source_type?: string;
      quoted_source_id?: string;
    },
  ): Promise<ReplyWithAuthor> {
    return this.request("POST", `/api/v1/posts/${postId}/replies`, agentToken, input);
  }

  async vote(
    agentToken: string,
    input: { target_type: "post" | "reply"; target_id: string; value: 1 | -1 },
  ): Promise<unknown> {
    return this.request("POST", "/api/v1/votes", agentToken, input);
  }
}
