Custom Subtitles now includes a Windows installer with its own Node.js runtime and optional automatic installation of Tailscale on the server.

Download **CustomSubtitles-1.1.0-Setup-x64.exe**, install it, and open the desktop shortcut. Create an administrator password in the local web interface, sign into Tailscale on the server, then use **Connection → Enable public access**. If your Tailscale account requests Funnel approval, follow its link and retry.

Your Xiaomi/Android TV boxes, Apple TV, phones, and other playback devices **do not need Tailscale**. They use the public HTTPS addon URL in a compatible Stremio client. Actual subtitle-addon support depends on the client.

Changes:

- English UI, README, validation errors, and runtime output.
- Public HTTPS through Tailscale Funnel, with a separate protected gateway.
- Required administrator password and local-only first-run owner setup.
- Password-protected uploads; read-only addon access through its private URL key.
- Bundled Node.js 24 LTS and a verified official Tailscale installer.
- Persistent user data across installer upgrades and uninstall.
- Automated source tests and a Windows installer smoke test before publication.

The installer is for **64-bit Windows 10/11 servers**. The application must remain running while devices fetch subtitles. Tailscale account login and Funnel approval cannot be performed automatically for you. This installer is currently unsigned; SHA-256 checksums are supplied in `SHA256SUMS.txt`.
