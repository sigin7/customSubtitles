The installed Windows application now checks for updates when it starts. When a newer stable GitHub release is available, it downloads the installer, verifies its SHA-256 checksum, installs silently, and reopens automatically.

- Keep the current application available if GitHub is offline or a download cannot be verified.
- Use a separate updater runtime to avoid Windows executable file locks.
- Preserve subtitles, administrator password, addon key, connection settings, and existing environment settings.
- Prevent simultaneous updates and skip Tailscale installation during application updates.
- Verify the full download, installation, reopen, and data-preservation sequence on the Windows build runner.

Download **CustomSubtitles-1.2.0-Setup-x64.exe** once to enable automatic updates on an older installation. Close Custom Subtitles before running the installer, then open it again. Future stable releases install automatically at startup. Set `AUTO_UPDATE=false` in the installation's `.env` to disable this behavior.

The installer includes Node.js 24 LTS and the optional official Tailscale installer. Only the server needs Tailscale; playback devices use the public HTTPS addon address. The installer is for Windows 10/11 x64 and is currently unsigned. SHA-256 checksums are included in `SHA256SUMS.txt`.
