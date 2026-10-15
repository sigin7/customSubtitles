# Cloudflare deployment

Host the upload interface and Stremio subtitle addon on Cloudflare Workers. Your PC can be off. Playback devices need internet and a compatible Stremio client, with no Tailscale or helper app. D1 stores matching metadata and revocable login sessions; KV stores subtitle files. Both stores persist across deployments. The Windows/local server remains a separate deployment mode.

## Setup

Use Node.js 24 or newer. From the repository root:

```sh
cd cloudflare
npm install
npx wrangler login --scopes account:read user:read workers:write workers_scripts:write workers_kv:write d1:write
cd ..
node scripts/cloudflare-setup.mjs prepare
node scripts/cloudflare-setup.mjs provision
node scripts/cloudflare-setup.mjs deploy
```

Approve Wrangler in Cloudflare. The script creates a D1 database and KV namespace, applies the schema, generates private credentials, and deploys to a workers.dev HTTPS address. It does not purchase a domain, enable R2, or upgrade your plan. If Cloudflare requests a Workers subdomain, register one in its dashboard and rerun deployment.

`cloudflare/.cloudflare-secrets.local.json` contains `ADMIN_PASSWORD`, `SESSION_SECRET`, and `ADDON_KEY`. Keep a private backup. The password is a generated 32-character random value held as a Worker secret, with constant-time verification and persistent login attempt limits. Passwords and raw session tokens are not stored in D1. Sessions expire after 12 hours; logout revokes the current session. Changing `ADMIN_PASSWORD` invalidates existing sessions.

`cloudflare/wrangler.local.json` contains your account and storage bindings. Both local files, `.dev.vars`, `.wrangler`, and `node_modules` are excluded from Git. The checked-in `wrangler.jsonc` contains local-development placeholder IDs. For a login with multiple accounts, set `account_id` in the local config before provisioning.

Open the deployed site and sign in using the generated password. Upload subtitles and open **Connection → Open in Stremio**, or copy the complete manifest address. Keep it private: it grants read-only access to your library. Existing PC subtitles are not automatically copied to the cloud.

## Free plan and availability

Keep Workers Free selected in Cloudflare. No paid service is required. As checked in October 2026:

- Workers Free: 100,000 requests/day and 10 ms CPU time per request.
- KV Free: 1 GB, 100,000 key reads/day, 1,000 writes/day, and 1,000 deletes/day.
- D1 Free: 5 million rows read/day, 100,000 rows written/day, and a 500 MB per-database limit.

The app limits active subtitle data to 256 MB to leave space below provider limits. Uploads are limited to 10 MB after UTF-8 normalization. Large payloads can reach the Workers CPU limit; ordinary small subtitle files are the intended workload. Free quotas and provider availability apply. Other applications in your account can share these quotas. Reaching a quota can temporarily block operations; the app does not upgrade your plan automatically.

Workers serves requests without Render-style idle shutdown. KV is eventually consistent: new or deleted files can take roughly a minute, and sometimes longer, to propagate. A not-yet-propagated file returns a retry message. The Worker does not log subtitle content. Its observability is disabled to avoid recording private addon URLs by default.

Official references: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

## Updates and backups

After pulling code changes, run `node scripts/cloudflare-setup.mjs deploy` from the repository root. This reuses storage and credentials and updates the hosted app for every client. Apply schema updates separately using the provisioning command. Avoid deleting cloud resources or private local configuration during upgrades.

Retain original subtitle files and a private backup of the credentials. D1 exports contain metadata and sessions; subtitle content lives separately in KV. A D1 export alone is not a complete library backup. Export both stores through the provider tools for a full independent backup.

## Local development

Inside `cloudflare`, copy `.dev.vars.example` to `.dev.vars` and run:

```sh
npx wrangler d1 execute custom-subtitles --local --file schema.sql
npx wrangler dev
```

Example credentials are for local testing only. Local D1 and KV are separate from the deployed library. Cloud integration tests exercise real SQLite schema queries, sessions, password rotation, uploads, keyed Stremio responses, exact episodes, CORS, and storage failures. Browser and HTTP checks also run against Wrangler's local Workers runtime.
