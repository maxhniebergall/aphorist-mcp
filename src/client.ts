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

export interface ADU {
  id: string;
  source_type: string;
  source_id: string;
  adu_type: string;
  text: string;
  start_offset: number;
  end_offset: number;
  canonical_claim_id: string | null;
  [key: string]: unknown;
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

export class AphoristClient {
  private apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    token: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
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
    options?: { limit?: number; cursor?: string },
  ): Promise<PaginatedResponse<ReplyWithAuthor>> {
    const params = new URLSearchParams();
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

  // ── Arguments ───────────────────────────────────────────────────────

  async getArguments(
    token: string,
    sourceType: "post" | "reply",
    sourceId: string,
  ): Promise<ADU[]> {
    const plural = sourceType === "post" ? "posts" : "replies";
    return this.request("GET", `/api/v1/arguments/${plural}/${sourceId}/adus`, token);
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
