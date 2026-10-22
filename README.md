# AWEMCP — Blogger MCP Bridge

A private, self-hosted Model Context Protocol (MCP) server for managing [blogma-wa.blogspot.com](https://blogma-wa.blogspot.com/) with Google OAuth 2.0 and the official Blogger API v3.

## Features

- Streamable HTTP MCP endpoint at `/mcp`.
- Google OAuth; this app never asks for your Google password.
- OAuth tokens encrypted at rest with AES-256-GCM.
- MCP tools to check connection, list/read posts, create drafts, update, publish, and delete posts.
- Publishing and permanent deletion require explicit confirmation arguments.
- Health endpoint and a small connection dashboard.
- MCP endpoint protected by a separate bearer secret.

> This repository contains server software; it is not deployed just because the code is on GitHub. Deploy it to a host that supports HTTPS and a persistent writable data directory. Never commit real credentials.

## 1. Configure Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and enable **Blogger API v3**.
2. Configure the OAuth consent screen. If the app is in testing mode, add your Google account as a test user.
3. Create an OAuth Client ID of type **Web application**.
4. Register the redirect URI exactly: `https://YOUR-HOST/oauth2callback`. For local testing use `http://localhost:3000/oauth2callback`.
5. Keep the client secret private.

## 2. Set environment variables

Copy `.env.example` to `.env` for local use. Configure:

- `PUBLIC_BASE_URL`: public base URL, without a trailing slash.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: OAuth credentials.
- `GOOGLE_REDIRECT_URI`: must exactly match the registered redirect URI.
- `MCP_ACCESS_TOKEN`: long random secret for the MCP Authorization header.
- `TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte key (generate with `openssl rand -base64 32`).
- `BLOGGER_BLOG_URL`: defaults to `https://blogma-wa.blogspot.com/`.

Use your host's secret manager for all credentials in production. Never put secrets in GitHub, screenshots, or public frontend code.

## 3. Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
npm run typecheck
npm start
```

Open `http://localhost:3000`, choose **Connect Google Blogger**, and approve the requested Blogger permission. Check `/health` for service status.

## 4. Connect an MCP client

Use an MCP client that supports Streamable HTTP and custom headers:

- Endpoint: `https://YOUR-HOST/mcp`
- Header: `Authorization: Bearer YOUR_MCP_ACCESS_TOKEN`

The server's presence on GitHub does not itself connect it to ChatGPT. ChatGPT MCP/app connection options depend on the client, plan, and workspace features; configure the deployed endpoint in a compatible MCP client.

## Tools

| Tool | Purpose |
|---|---|
| `blogger_connection_status` | Verify Google authorization and resolve the target blog |
| `blogger_list_posts` | List LIVE, DRAFT, or SCHEDULED posts |
| `blogger_get_post` | Read a post by ID |
| `blogger_create_post` | Create a draft by default; publishing needs `confirmPublish: true` |
| `blogger_update_post` | Update title/content/labels; publishing needs `confirmPublish: true` |
| `blogger_delete_post` | Permanently delete only with `confirm: true` |

## Security and operations

- Use HTTPS outside local development.
- Keep `.env`, `.data/`, the OAuth client secret, encryption key, and MCP bearer token private.
- Persist the `.data` directory across restarts. Losing the encryption key makes the saved OAuth grant unreadable.
- This initial version is intended for one trusted blog owner, not multi-user public hosting.
- The deployment must restrict access to trusted users; the MCP bearer token is a powerful credential.
- Consider adding automated tests, audit logging, and rate limiting before exposing it broadly.

## License

Add a license before redistributing.
