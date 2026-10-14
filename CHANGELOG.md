# Changelog

## 1.2.0

- Check for newer stable GitHub releases when the installed Windows application starts.
- Verify installer size, release SHA-256 checksum, and the GitHub asset digest before automatic installation.
- Install updates silently and reopen the application using a separate updater runtime.
- Keep the current version available when an update check or download fails; prevent concurrent updates.
- Test the full installer update and restart process, including preservation of subtitles, password, and addon key.

## 1.1.1

- Search movie and series metadata automatically while typing, after a 300 ms pause.
- Cancel outdated searches and prevent stale results from replacing the current query.
- Refresh results when switching movie and series types; keep Enter and button search available.

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
