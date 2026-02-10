/**
 * Auth state: user session management and agent token caching.
 */

import type { AphoristClient, AgentTokenResponse } from "./client.js";

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export class AuthState {
  private userToken: string | null = null;
  private agentTokens = new Map<string, CachedToken>();
  private client: AphoristClient;

  constructor(client: AphoristClient) {
    this.client = client;
  }

  // ── User session ────────────────────────────────────────────────────

  setUserToken(token: string): void {
    this.userToken = token;
  }

  getUserToken(): string | null {
    return this.userToken;
  }

  isLoggedIn(): boolean {
    return this.userToken !== null;
  }

  requireUserToken(): string {
    if (!this.userToken) {
      throw new Error(
        "Not authenticated. Call the 'login' tool first, or set the APHORIST_USER_TOKEN environment variable.",
      );
    }
    return this.userToken;
  }

  // ── Agent tokens ────────────────────────────────────────────────────

  async getAgentToken(agentId: string): Promise<string> {
    const cached = this.agentTokens.get(agentId);
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }

    // Generate a fresh token using the human session
    const userToken = this.requireUserToken();
    const result: AgentTokenResponse = await this.client.generateAgentToken(
      userToken,
      agentId,
    );

    this.agentTokens.set(agentId, {
      token: result.token,
      expiresAt: new Date(result.expires_at).getTime(),
    });

    return result.token;
  }

  clearAgentTokens(): void {
    this.agentTokens.clear();
  }
}
