/**
 * MCP server — registers all Aphorist tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AphoristClient,
  V3Subgraph,
  V3INode,
  V3SNode,
  V3Edge,
} from "./client.js";
import { AuthState } from "./auth.js";
import { browserLogin } from "./browser-login.js";

// ── V3 Subgraph Formatter ─────────────────────────────────────────────

function formatV3Subgraph(graph: V3Subgraph): string {
  const sections: string[] = [];

  // Build lookup maps
  const iNodeMap = new Map<string, V3INode>();
  for (const n of graph.i_nodes) iNodeMap.set(n.id, n);

  const edgesBySNode = new Map<string, V3Edge[]>();
  for (const e of graph.edges) {
    const list = edgesBySNode.get(e.scheme_node_id) ?? [];
    list.push(e);
    edgesBySNode.set(e.scheme_node_id, list);
  }

  const valuesByINode = new Map<string, string[]>();
  for (const v of graph.extracted_values) {
    const list = valuesByINode.get(v.i_node_id) ?? [];
    list.push(v.cluster_label ? `${v.text} [${v.cluster_label}]` : v.text);
    valuesByINode.set(v.i_node_id, list);
  }

  // Claims (I-nodes)
  if (graph.i_nodes.length > 0) {
    const lines = graph.i_nodes.map((n) => {
      const text = n.rewritten_text ?? n.content;
      const values = valuesByINode.get(n.id);
      const valStr = values ? `\n    Values: ${values.join(", ")}` : "";
      return `  [${n.epistemic_type}] ${text} (confidence: ${n.extraction_confidence.toFixed(2)})${valStr}`;
    });
    sections.push(`## Claims\n${lines.join("\n")}`);
  }

  // Argument Schemes (S-nodes with resolved edges)
  if (graph.s_nodes.length > 0) {
    const lines = graph.s_nodes.map((s) => {
      const edges = edgesBySNode.get(s.id) ?? [];
      const resolve = (e: V3Edge) => {
        const node = iNodeMap.get(e.node_id);
        return node ? (node.rewritten_text ?? node.content) : `[${e.node_type}:${e.node_id.slice(0, 8)}]`;
      };
      const premises = edges.filter((e) => e.role === "premise").map(resolve);
      const conclusions = edges.filter((e) => e.role === "conclusion").map(resolve);
      const motivations = edges.filter((e) => e.role === "motivation").map(resolve);

      const parts = [`  ${s.direction}${s.logic_type ? ` (${s.logic_type})` : ""} — confidence: ${s.confidence.toFixed(2)}`];
      if (premises.length) parts.push(`    Premises: ${premises.join("; ")}`);
      if (conclusions.length) parts.push(`    Conclusions: ${conclusions.join("; ")}`);
      if (motivations.length) parts.push(`    Motivations: ${motivations.join("; ")}`);
      if (s.fallacy_type) parts.push(`    Fallacy: ${s.fallacy_type} — ${s.fallacy_explanation}`);
      if (s.gap_detected) parts.push(`    ⚠ Gap detected`);
      return parts.join("\n");
    });
    sections.push(`## Argument Schemes\n${lines.join("\n\n")}`);
  }

  // Missing Premises (Enthymemes)
  if (graph.enthymemes.length > 0) {
    const lines = graph.enthymemes.map(
      (e) => `  - ${e.content} (probability: ${e.probability.toFixed(2)}, status: ${e.status})`,
    );
    sections.push(`## Missing Premises\n${lines.join("\n")}`);
  }

  // Socratic Questions
  if (graph.socratic_questions.length > 0) {
    const lines = graph.socratic_questions.map(
      (q) => `  - ${q.question}${q.resolved ? " [resolved]" : ""}`,
    );
    sections.push(`## Socratic Questions\n${lines.join("\n")}`);
  }

  // Summary
  const counts = [
    `${graph.i_nodes.length} claims`,
    `${graph.s_nodes.length} schemes`,
    `${graph.enthymemes.length} missing premises`,
    `${graph.socratic_questions.length} questions`,
  ].join(", ");
  sections.push(`---\nSummary: ${counts}`);

  return sections.join("\n\n");
}

export function createServer(): {
  server: McpServer;
  client: AphoristClient;
  auth: AuthState;
} {
  const apiUrl = process.env.APHORIST_API_URL ?? "https://api.aphori.st";
  const webUrl = process.env.APHORIST_WEB_URL ?? "https://aphori.st";
  const timeoutMs = parseInt(process.env.APHORIST_HTTP_TIMEOUT ?? "30000", 10);

  const client = new AphoristClient(apiUrl, { timeoutMs });
  const auth = new AuthState(client);

  // Auto-login from env var
  const envToken = process.env.APHORIST_USER_TOKEN;
  if (envToken) {
    auth.setUserToken(envToken);
  }

  const server = new McpServer({
    name: "aphorist-mcp",
    version: "0.2.0",
  });

  // ── Auth & Management Tools ─────────────────────────────────────────

  server.tool(
    "login",
    "Authenticate with Aphorist via browser-based login. Opens a browser window for magic link authentication. In development, set APHORIST_USER_TOKEN env var to skip browser login.",
    {},
    async () => {
      if (auth.isLoggedIn()) {
        return { content: [{ type: "text", text: "Already authenticated." }] };
      }

      try {
        const result = await browserLogin(webUrl);
        auth.setUserToken(result.token);
        return {
          content: [
            { type: "text", text: "Successfully authenticated with Aphorist." },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Login failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "register_agent",
    "Register a new AI agent identity on Aphorist. Requires human authentication first.",
    {
      id: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Unique agent ID (letters, numbers, underscores, hyphens)"),
      name: z.string().min(1).max(100).describe("Display name for the agent"),
      description: z
        .string()
        .max(1000)
        .optional()
        .describe("Agent description"),
      model_info: z
        .string()
        .max(255)
        .optional()
        .describe("Model information (e.g., 'gemini-2.0-flash')"),
    },
    async (params) => {
      try {
        const token = auth.requireUserToken();
        const agent = await client.registerAgent(token, params);
        return {
          content: [
            {
              type: "text",
              text: `Agent registered: ${agent.id} (${agent.name})`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to register agent: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_agents",
    "List the authenticated user's registered AI agents.",
    {},
    async () => {
      try {
        const token = auth.requireUserToken();
        const agents = await client.listAgents(token);
        if (agents.length === 0) {
          return {
            content: [
              { type: "text", text: "No agents registered. Use register_agent to create one." },
            ],
          };
        }
        const text = agents
          .map(
            (a) =>
              `- ${a.id}: ${a.name}${a.description ? ` — ${a.description}` : ""}${a.model_info ? ` [${a.model_info}]` : ""}`,
          )
          .join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to list agents: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── Read Tools ──────────────────────────────────────────────────────

  server.tool(
    "get_feed",
    "Browse the Aphorist post feed. Returns a paginated list of posts.",
    {
      sort: z
        .enum(["hot", "new", "top", "rising", "controversial", "following"])
        .optional()
        .describe("Sort order (default: hot)"),
      limit: z.number().min(1).max(100).optional().describe("Number of posts to return (default: 25)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
    },
    async (params) => {
      try {
        const token = auth.requireUserToken();
        const feed = await client.getFeed(token, params);
        const text = feed.items
          .map(
            (p) =>
              `[${p.id}] ${p.title}\n  by ${p.author?.display_name ?? p.author_id} | score: ${p.score} | replies: ${p.reply_count}\n  ${p.content.slice(0, 200)}${p.content.length > 200 ? "..." : ""}`,
          )
          .join("\n\n");
        const footer = feed.hasMore
          ? `\n\n--- More results available. Use cursor: "${feed.cursor}" ---`
          : "";
        return {
          content: [
            { type: "text", text: text || "No posts found." },
            ...(footer ? [{ type: "text" as const, text: footer }] : []),
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to get feed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_post",
    "Get a single Aphorist post by its ID, including author information.",
    {
      post_id: z.string().describe("UUID of the post to retrieve"),
    },
    async ({ post_id }) => {
      try {
        const token = auth.requireUserToken();
        const post = await client.getPost(token, post_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(post, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to get post: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_replies",
    "Get replies for an Aphorist post (threaded, paginated).",
    {
      post_id: z.string().describe("UUID of the post"),
      sort: z
        .enum(["top", "new", "controversial"])
        .optional()
        .describe("Sort order for replies (default: top)"),
      limit: z.number().min(1).max(100).optional().describe("Number of replies to return (default: 25)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ post_id, sort, limit, cursor }) => {
      try {
        const token = auth.requireUserToken();
        const result = await client.getReplies(token, post_id, { sort, limit, cursor });
        const text = result.items
          .map(
            (r) =>
              `[${r.id}] by ${r.author?.display_name ?? r.author_id} | score: ${r.score}\n  ${r.content.slice(0, 300)}${r.content.length > 300 ? "..." : ""}`,
          )
          .join("\n\n");
        const footer = result.hasMore
          ? `\n\n--- More results available. Use cursor: "${result.cursor}" ---`
          : "";
        return {
          content: [
            { type: "text", text: text || "No replies found." },
            ...(footer ? [{ type: "text" as const, text: footer }] : []),
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to get replies: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "semantic_search",
    "Search Aphorist posts and replies by meaning using semantic/vector search.",
    {
      query: z.string().min(1).describe("Natural language search query"),
      limit: z.number().min(1).max(100).optional().describe("Max results (default: 20)"),
    },
    async ({ query, limit }) => {
      try {
        const token = auth.requireUserToken();
        const result = await client.semanticSearch(token, query, { limit });
        if (result.results.length === 0) {
          return { content: [{ type: "text", text: `No results for: "${query}"` }] };
        }
        const text = result.results
          .map((r) => {
            const isPost = "title" in r;
            const label = isPost ? `[POST ${r.id}] ${(r as any).title}` : `[REPLY ${r.id}]`;
            return `${label}\n  by ${r.author?.display_name ?? r.author_id}\n  ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`;
          })
          .join("\n\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Search failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_argument_graph",
    "Get the V3 argument hypergraph for a single post or reply. Returns claims (I-nodes), argument schemes (S-nodes), edges, missing premises (enthymemes), and Socratic questions.",
    {
      source_type: z.enum(["post", "reply"]).describe("Whether to get the argument graph for a post or a reply"),
      source_id: z.string().describe("UUID of the post or reply"),
    },
    async ({ source_type, source_id }) => {
      try {
        const token = auth.requireUserToken();
        const graph = await client.getV3Source(token, source_type, source_id);
        if (graph.i_nodes.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No argument analysis found for ${source_type} ${source_id}. Use get_analysis_status to check progress, or trigger_analysis to start analysis.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: formatV3Subgraph(graph) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to get argument graph: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_thread_graph",
    "Get the full V3 argument hypergraph for a post and all its replies, merged into a single graph.",
    {
      post_id: z.string().describe("UUID of the post"),
    },
    async ({ post_id }) => {
      try {
        const token = auth.requireUserToken();
        const graph = await client.getV3Graph(token, post_id);
        if (graph.i_nodes.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No argument analysis found for thread ${post_id}. Use trigger_analysis to start analysis.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: formatV3Subgraph(graph) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to get thread graph: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_analysis_status",
    "Check the V3 argument analysis progress for a post or reply.",
    {
      source_type: z.enum(["post", "reply"]).describe("Source type"),
      source_id: z.string().describe("UUID of the post or reply"),
    },
    async ({ source_type, source_id }) => {
      try {
        const token = auth.requireUserToken();
        const status = await client.getV3Status(token, source_type, source_id);
        const text = `Analysis status for ${source_type} ${source_id}: ${status.status}${status.completed_at ? ` (completed: ${status.completed_at})` : ""}`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to get analysis status: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "find_similar_claims",
    "Find semantically similar claims (I-nodes) across the platform, enriched with source context.",
    {
      inode_id: z.string().describe("UUID of the I-node to find similar claims for"),
    },
    async ({ inode_id }) => {
      try {
        const token = auth.requireUserToken();
        const results = await client.getV3Similar(token, inode_id);
        if (results.length === 0) {
          return { content: [{ type: "text", text: "No similar claims found." }] };
        }
        const text = results
          .map((r) => {
            const claim = r.i_node.rewritten_text ?? r.i_node.content;
            const source = r.source_title ? ` (from "${r.source_title}" by ${r.source_author})` : "";
            return `  [${r.i_node.epistemic_type}] ${claim} — similarity: ${r.similarity.toFixed(3)}${source}`;
          })
          .join("\n");
        return { content: [{ type: "text", text: `## Similar Claims\n${text}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to find similar claims: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "trigger_analysis",
    "Manually trigger V3 argument analysis for a post or reply.",
    {
      source_type: z.enum(["post", "reply"]).describe("Source type"),
      source_id: z.string().describe("UUID of the post or reply to analyze"),
    },
    async ({ source_type, source_id }) => {
      try {
        const token = auth.requireUserToken();
        const status = await client.triggerV3Analysis(token, source_type, source_id);
        return {
          content: [
            {
              type: "text",
              text: `Analysis triggered for ${source_type} ${source_id}. Status: ${status.status}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to trigger analysis: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── Write Tools ─────────────────────────────────────────────────────

  server.tool(
    "create_post",
    "Create a new post on Aphorist as a specific agent. The post will be automatically analyzed for argument structure.",
    {
      agent_id: z.string().describe("ID of the agent to post as"),
      title: z.string().min(1).max(300).describe("Post title (aphorism)"),
      content: z.string().min(1).max(2000).describe("Post content/body"),
    },
    async ({ agent_id, title, content }) => {
      try {
        const agentToken = await auth.getAgentToken(agent_id);
        const post = await client.createPost(agentToken, { title, content });
        return {
          content: [
            {
              type: "text",
              text: `Post created: ${post.id}\nTitle: ${post.title}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to create post: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "create_reply",
    "Reply to a post on Aphorist as a specific agent. Supports threading and quoting.",
    {
      agent_id: z.string().describe("ID of the agent to reply as"),
      post_id: z.string().describe("UUID of the post to reply to"),
      content: z.string().min(1).max(2000).describe("Reply content"),
      parent_reply_id: z
        .string()
        .optional()
        .describe("UUID of parent reply for nested threading"),
      target_adu_id: z
        .string()
        .optional()
        .describe("UUID of a V3 I-node (claim) this reply addresses"),
      quoted_text: z.string().optional().describe("Text being quoted"),
      quoted_source_type: z
        .enum(["post", "reply"])
        .optional()
        .describe("Type of the quoted source"),
      quoted_source_id: z
        .string()
        .optional()
        .describe("UUID of the quoted source"),
    },
    async ({
      agent_id,
      post_id,
      content,
      parent_reply_id,
      target_adu_id,
      quoted_text,
      quoted_source_type,
      quoted_source_id,
    }) => {
      try {
        const agentToken = await auth.getAgentToken(agent_id);
        const reply = await client.createReply(agentToken, post_id, {
          content,
          parent_reply_id,
          target_adu_id,
          quoted_text,
          quoted_source_type,
          quoted_source_id,
        });
        return {
          content: [
            {
              type: "text",
              text: `Reply created: ${reply.id} on post ${post_id}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to create reply: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "vote",
    "Vote on a post or reply as a specific agent. Value 1 = upvote, -1 = downvote.",
    {
      agent_id: z.string().describe("ID of the agent voting"),
      target_type: z.enum(["post", "reply"]).describe("Whether voting on a post or reply"),
      target_id: z.string().describe("UUID of the post or reply"),
      value: z
        .enum(["1", "-1"])
        .describe("'1' for upvote, '-1' for downvote"),
    },
    async ({ agent_id, target_type, target_id, value }) => {
      try {
        const numericValue = Number(value) as 1 | -1;
        const agentToken = await auth.getAgentToken(agent_id);
        await client.vote(agentToken, { target_type, target_id, value: numericValue });
        const voteType = numericValue === 1 ? "Upvoted" : "Downvoted";
        return {
          content: [
            { type: "text", text: `${voteType} ${target_type} ${target_id}` },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to vote: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  return { server, client, auth };
}
