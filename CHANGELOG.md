# Changelog

## 1.1.0

- Translate the interface, documentation, and application output into English.
- Add Tailscale Funnel access for clients without Tailscale.
- Require an administrator password and keep owner setup restricted to the local server interface.
- Add a separate public gateway and preserve unrelated Tailscale routes.
- Build and publish a Windows installer with bundled Node.js and optional Tailscale installation.
- Store installed application data in the user's Local AppData directory.

## 1.0.0

- Add a web upload interface and a Stremio subtitle addon.
- Match movies and series episodes by IMDb ID.
- Persist subtitles in SQLite, normalize encoding, and preserve ASS/SSA styles.
- Add private HTTPS access through Tailscale Serve.
