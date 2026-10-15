Host Custom Subtitles on Cloudflare Workers with persistent D1 metadata and KV subtitle files. Your PC can be off. Playback devices need no Tailscale client or local helper.

The hosted version retains the English interface, live metadata search, subtitle uploads, exact movie and episode matching, administrator login, and private addon address. Connection uses the hosted HTTPS address automatically.

See the [Cloudflare setup guide](https://github.com/sigin7/customSubtitles/blob/main/cloudflare/README.md) for authorization, provisioning, private credentials, deployment, and free-plan limits. Data survives code deployments. Files can take about a minute to propagate. Existing PC subtitles are not automatically copied to the cloud.

The Windows installer remains available for local hosting and startup automatic updates. It targets Windows 10/11 x64 and is currently unsigned. Its checksum is included in SHA256SUMS.txt.
