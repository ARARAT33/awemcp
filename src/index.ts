import express, { type Request, type Response, type NextFunction } from "express";
import { google } from "googleapis";
import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const BLOG_URL = process.env.BLOGGER_BLOG_URL ?? "https://blogma-wa.blogspot.com/";
const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN ?? "";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? `${BASE_URL}/oauth2callback`;
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? ".data");
const TOKEN_FILE = path.join(DATA_DIR, "google-token.enc");
const KEY = process.env.TOKEN_ENCRYPTION_KEY ?? "";

function oauthClient() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}
function encryptionKey(): Buffer {
  if (!KEY) throw new Error("TOKEN_ENCRYPTION_KEY is required before saving OAuth credentials.");
  const key = Buffer.from(KEY, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}
async function saveTokens(tokens: object) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  const payload = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
  await writeFile(TOKEN_FILE, JSON.stringify(payload), { mode: 0o600 });
}
async function loadTokens(): Promise<Record<string, unknown> | null> {
  try {
    const payload = JSON.parse(await readFile(TOKEN_FILE, "utf8")) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const clear = Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(clear) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function getAuthorizedClient() {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Blogger is not connected. Open /auth/google and complete Google OAuth first.");
  const client = oauthClient();
  client.setCredentials(tokens);
  client.on("tokens", async updated => {
    try { await saveTokens({ ...tokens, ...updated }); }
    catch (e) { console.error("Could not persist refreshed OAuth credentials:", e instanceof Error ? e.message : "unknown error"); }
  });
  return client;
}
async function getBlogId(): Promise<string> {
  const auth = await getAuthorizedClient();
  const blogger = google.blogger({ version: "v3", auth });
  const response = await blogger.blogs.getByUrl({ url: BLOG_URL });
  const id = response.data.id;
  if (!id) throw new Error(`Could not resolve Blogger blog ID for ${BLOG_URL}`);
  return id;
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

app.get("/", async (_req, res) => {
  let connected = false;
  try { connected = Boolean(await loadTokens()); } catch { /* surfaced on health endpoint */ }
  res.type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AWEMCP · Blogger</title><style>body{font:16px system-ui;max-width:760px;margin:8vh auto;padding:24px;background:#101522;color:#edf2ff}a,button{color:#fff;background:#315efb;border:0;border-radius:10px;padding:12px 18px;text-decoration:none;display:inline-block}code{background:#222b40;padding:3px 6px;border-radius:5px}.muted{color:#aab5ce}.card{border:1px solid #303a51;border-radius:16px;padding:22px;margin:18px 0}</style><h1>AWEMCP · Blogger Bridge</h1><p class="muted">Secure MCP server for <code>${BLOG_URL}</code></p><div class="card"><h2>Google Blogger connection</h2><p>Status: <strong>${connected ? "OAuth credentials saved" : "Not connected"}</strong></p><a href="/auth/google">Connect Google Blogger</a><p class="muted">Google access is granted through OAuth. Never enter your Google password here.</p></div><div class="card"><h2>MCP endpoint</h2><p><code>${BASE_URL}/mcp</code></p><p class="muted">Streamable HTTP. Configure your MCP client with this URL and the Bearer token set in <code>MCP_ACCESS_TOKEN</code>.</p></div><p class="muted">Health: <a href="/health">/health</a> · Privacy: OAuth tokens are encrypted at rest.</p></html>`);
});
app.get("/health", async (_req, res) => {
  let oauthConfigured = Boolean(CLIENT_ID && CLIENT_SECRET && KEY && ACCESS_TOKEN);
  let tokenSaved = false;
  try { tokenSaved = Boolean(await loadTokens()); } catch { /* do not expose secret details */ }
  res.status(oauthConfigured ? 200 : 503).json({ status: oauthConfigured ? "ok" : "configuration_required", service: "awemcp-blogger", mcpEndpoint: "/mcp", oauthConfigured, bloggerConnected: tokenSaved });
});
app.get("/auth/google", (_req, res) => {
  try {
    const state = randomBytes(24).toString("hex");
    res.cookie("awemcp_oauth_state", state, { httpOnly: true, secure: BASE_URL.startsWith("https://"), sameSite: "lax", maxAge: 10 * 60 * 1000 });
    const url = oauthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/blogger"], state });
    res.redirect(url);
  } catch (error) { res.status(500).send(safeError(error)); }
});
app.get("/oauth2callback", async (req, res) => {
  try {
    const state = String(req.query.state ?? "");
    // Parse the state cookie without requiring a cookie middleware dependency.
    const cookieHeader = req.headers.cookie ?? "";
    const stateCookie = cookieHeader.split(";").map(v => v.trim()).find(v => v.startsWith("awemcp_oauth_state="))?.slice("awemcp_oauth_state=".length) ?? "";
    const cookieState = decodeURIComponent(stateCookie);
    if (!state || !cookieState || state.length !== cookieState.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookieState))) {
      res.status(400).send("OAuth state validation failed. Return to the AWEMCP home page and try again.");
      return;
    }
    const code = String(req.query.code ?? "");
    if (!code) { res.status(400).send("Google did not return an authorization code."); return; }
    const { tokens } = await oauthClient().getToken(code);
    if (!tokens.access_token) throw new Error("Google OAuth did not return an access token.");
    await saveTokens(tokens);
    res.setHeader("Set-Cookie", "awemcp_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.redirect("/?connected=1");
  } catch (error) { res.status(500).send(`OAuth failed: ${safeError(error)}`); }
});

function requireMcpBearer(req: Request, res: Response, next: NextFunction) {
  if (!ACCESS_TOKEN) { res.status(503).json({ error: "MCP_ACCESS_TOKEN is not configured." }); return; }
  const header = req.header("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(ACCESS_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}

function buildMcpServer() {
  const server = new McpServer({ name: "awemcp-blogger", version: "1.0.0" });
  server.tool("blogger_connection_status", "Check whether Google Blogger OAuth is connected and resolve the configured blog.", {}, async () => {
    try {
      const blogId = await getBlogId();
      return { content: [{ type: "text", text: JSON.stringify({ connected: true, blogUrl: BLOG_URL, blogId }) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: safeError(e) }] }; }
  });
  server.tool("blogger_list_posts", "List posts from the configured Blogger blog.", {
    status: z.enum(["LIVE", "DRAFT", "SCHEDULED"]).optional(),
    maxResults: z.number().int().min(1).max(100).optional()
  }, async ({ status, maxResults }) => {
    try {
      const auth = await getAuthorizedClient();
      const blogger = google.blogger({ version: "v3", auth });
      const blogId = await getBlogId();
      const result = await blogger.posts.list({ blogId, status: status ? [status] : undefined, maxResults: maxResults ?? 20, fetchBodies: true, orderBy: "UPDATED" });
      const posts = (result.data.items ?? []).map(p => ({ id: p.id, title: p.title, status: p.status, url: p.url, updated: p.updated, published: p.published, labels: p.labels, content: p.content }));
      return { content: [{ type: "text", text: JSON.stringify({ count: posts.length, posts }, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: safeError(e) }] }; }
  });
  server.tool("blogger_get_post", "Read a single Blogger post by its numeric post ID.", { postId: z.string().min(1) }, async ({ postId }) => {
    try {
      const auth = await getAuthorizedClient(); const blogger = google.blogger({ version: "v3", auth }); const blogId = await getBlogId();
      const result = await blogger.posts.get({ blogId, postId });
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: safeError(e) }] }; }
  });
  server.tool("blogger_create_post", "Create a Blogger post. Defaults to a draft; set publish=true only when publication is intended.", {
    title: z.string().min(1).max(300), content: z.string().min(1), labels: z.array(z.string().max(100)).max(50).optional(),
    publish: z.boolean().default(false), confirmPublish: z.boolean().optional()
  }, async ({ title, content, labels, publish, confirmPublish }) => {
    try {
      if (publish && confirmPublish !== true) throw new Error("Publishing requires confirmPublish=true. Create a draft or explicitly confirm publication.");
      const auth = await getAuthorizedClient(); const blogger = google.blogger({ version: "v3", auth }); const blogId = await getBlogId();
      const result = await blogger.posts.insert({ blogId, isDraft: !publish, requestBody: { title, content, labels } });
      return { content: [{ type: "text", text: JSON.stringify({ created: true, published: publish, post: result.data }, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: safeError(e) }] }; }
  });
  server.tool("blogger_update_post", "Update an existing Blogger post. Publishing an existing draft requires confirmPublish=true.", {
    postId: z.string().min(1), title: z.string().min(1).max(300).optional(), content: z.string().min(1).optional(),
    labels: z.array(z.string().max(100)).max(50).optional(), publish: z.boolean().optional(), confirmPublish: z.boolean().optional()
  }, async ({ postId, title, content, labels, publish, confirmPublish }) => {
    try {
      if (publish && confirmPublish !== true) throw new Error("Publishing requires confirmPublish=true.");
      if (!title && !content && !labels && !publish) throw new Error("Provide at least one field to update.");
      const auth = await getAuthorizedClient(); const blogger = google.blogger({ version: "v3", auth }); const blogId = await getBlogId();
      const current = (await blogger.posts.get({ blogId, postId })).data;
      const body = { title: title ?? current.title, content: content ?? current.content, labels: labels ?? current.labels };
      const updated = await blogger.posts.update({ blogId, postId, requestBody: body });
      const result = publish
        ? await blogger.posts.publish({ blogId, postId })
        : { data: updated.data };
      return { content: [{ type: "text", text: JSON.stringify({ updated: true, post: result.data }, null, 2) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: safeError(e) }] }; }
  });
  server.tool("blogger_delete_post", "Permanently delete a Blogger post. This action is irreversible and requires confirm=true.", {
    postId: z.string().min(1), confirm: z.boolean()
  }, async ({ postId, confirm }) => {
    try {
      if (confirm !== true) throw new Error("Deletion requires confirm=true.");
      const auth = await getAuthorizedClient(); const blogger = google.blogger({ version: "v3", auth }); const blogId = await getBlogId();
      await blogger.posts.delete({ blogId, postId });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true, postId }) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: safeError(e) }] }; }
  });
  return server;
}

app.post("/mcp", requireMcpBearer, async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: safeError(error) });
  }
});
app.get("/mcp", requireMcpBearer, (_req, res) => res.status(405).json({ error: "Use POST for stateless Streamable HTTP MCP requests." }));
app.delete("/mcp", requireMcpBearer, (_req, res) => res.status(405).json({ error: "Stateless MCP endpoint does not use DELETE." }));

app.listen(PORT, () => {
  console.log(`AWEMCP Blogger MCP listening on port ${PORT}`);
  console.log(`Blog target: ${BLOG_URL}`);
  if (!ACCESS_TOKEN) console.warn("MCP_ACCESS_TOKEN is not set; MCP requests will be rejected.");
});
