# Custom Subtitles

A personal Stremio subtitle addon with a web upload interface. Run it on your Windows server, upload your subtitle files, and select them when watching the matching movie or episode.

**Only the server needs Tailscale. Your playback devices do not.** Tailscale Funnel provides a public HTTPS address that compatible Stremio clients can reach over a normal internet connection.

## Download and install

Download the latest `CustomSubtitles-…-Setup-x64.exe` from [GitHub Releases](https://github.com/sigin7/customSubtitles/releases/latest).

The Windows 10/11 x64 installer includes:

- A private Node.js 24 LTS runtime. No separate Node.js or npm installation is needed.
- The application, web interface, and desktop/Start Menu shortcuts.
- The official Tailscale installer, installed automatically if missing and its setup task is selected. Windows will request administrator approval for Tailscale installation.

The application itself installs for your user under `%LOCALAPPDATA%\Programs\CustomSubtitles`. It does not change your system PATH. Tailscale remains a separate installed application.

1. Run the installer and open **Custom Subtitles** from its shortcut.
2. The server starts and opens `http://127.0.0.1:7000`. Create an administrator password of at least 12 characters in this local interface.
3. Sign into Tailscale **on the server only**. This account login cannot be automated by the installer.
4. Open **Connection → Enable public access**. If Tailscale requests permission to enable Funnel, open the provided account link, approve it, and click the button again.
5. The public address will look like `https://your-server.your-tailnet.ts.net:8443`. Use **Open in Stremio**, or copy the complete addon manifest address into Stremio's Addons screen.

Leave the server console open while using the addon. Press **Ctrl+C** to stop it. Closing the console also stops the application. Funnel may remain configured in the background, but it cannot serve subtitles while the application is stopped. The server computer must stay awake.

The installer is currently unsigned. Release artifacts include `SHA256SUMS.txt`; the bundled runtime and Tailscale installer are checked against their official published checksums during the build.

## Playback devices without Tailscale

Install the **public HTTPS addon address** in your Stremio client or synchronize it through your Stremio account. The URL contains a private read-only key:

```text
https://your-server.your-tailnet.ts.net:8443/addon/<private-key>/manifest.json
```

Your Xiaomi/Android TV box, phone, Apple TV, or other client needs only internet access and a player that supports the Stremio subtitle-addon protocol. Device-specific client support still matters: a reachable HTTPS server cannot add subtitle-addon support to a client that lacks it. Keep the full URL private.

You can also open the public web interface from a normal browser without Tailscale. Library management and uploads require your administrator password. First-run password creation and enabling public network access are available only through the local interface on the server.

If you installed an older addon using a private Tailscale Serve URL, remove that version and install the new public address. Existing subtitles and the addon key are retained when upgrading the source project.

## Uploading and matching subtitles

1. Select **Movie** or **Series**. Type a title or IMDb ID; results appear automatically after at least two characters and a short pause. Select the correct result. Enter and the search button also search immediately. Cinemeta metadata search requires internet access; manual title and IMDb entry works offline.
2. For series, specify the season and episode. Season `0` is supported for specials.
3. Drop or select one `.srt`, `.vtt`, `.ass`, or `.ssa` file, up to 10 MB. Select its language and optionally label the release version, such as `1080p BluRay`.
4. Click **Upload to library**. Identical content with the same video, language, and version label is not inserted twice.

Movies match IMDb IDs such as `tt1375666`. Episodes match the series IMDb ID plus season and episode, such as `tt0903747:1:2`. The display title does not determine matching. Filenames can suggest `S01E02`, `1x02`, IMDb IDs, and SK/CZ/EN language markers; review these suggestions before uploading.

Videos identified exclusively by `tmdb:` or another addon's custom IDs are not matched. Multiple subtitle versions can be provided for the same video, but you choose the version with the right timing for your stream. Automatic timing correction is not included.

Uploads are normalized to UTF-8. Automatic decoding supports UTF-8, UTF-16 with a BOM, and Windows-1250 when UTF-8 decoding fails. Select the encoding manually if needed. ASS/SSA styles are preserved; rendering depends on your player and its settings.

## Public HTTPS architecture

```text
Any device / Stremio client
    → public HTTPS :8443
    → Tailscale Funnel on the server
    → protected gateway on 127.0.0.1:7001
    → web interface / password-protected API / keyed subtitle addon

Server browser
    → local interface on 127.0.0.1:7000
    → first-run owner setup and network configuration
```

The application preserves unrelated Tailscale routes. The default public Funnel port is `8443`, so an existing private Serve route on HTTPS `443` can remain intact. A conflicting route on the selected port is reported instead of overwritten. The optional command equivalent is:

```powershell
tailscale funnel --bg --https=8443 http://127.0.0.1:7001
```

After running the command manually, set the resulting public HTTPS origin in **Connection**. Funnel is public internet access; ordinary Tailscale Serve remains private and would require Tailscale on clients. The gateway refuses public addon access until the administrator password is configured, rejects remote owner setup, and requires authentication for uploads, settings, and deletion. Subtitle playback uses only the read-only key, so TV clients never need your administrator password.

Funnel availability and throughput are subject to Tailscale's service limits. See the [official Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel) and [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel).

## Data, upgrades, and backups

Installed application data lives in `%LOCALAPPDATA%\CustomSubtitles\data`. Source checkouts use `./data` by default. SQLite stores subtitles, the password hash, addon key, and saved connection settings.

Updates and uninstall preserve the installed user data directory. Stop the application before backing up the entire data directory, including any SQLite WAL files. Run one application instance per database.

To move a library from a source checkout into an installed application, stop both instances and copy the source `data` directory into `%LOCALAPPDATA%\CustomSubtitles\data` before opening the installed version. Preserve a backup. Uninstalling Custom Subtitles does not uninstall Tailscale.

`.env`, subtitle databases, build output, and local user data are excluded from Git and from release payloads. If you choose a custom data directory inside the repository, add it to `.gitignore`.

## Source development in VS Code

Install Node.js 24 LTS, clone the repository, and open its folder in VS Code. No npm dependencies are required.

```powershell
node --env-file-if-exists=.env src/launcher.js
```

`npm start`, `start.cmd`, and the **Custom Subtitles: server + web** F5 configuration also work. On this Windows machine, the alternate F5 configuration can use the existing Codex Node runtime if system Node is unavailable.

```powershell
node scripts/check.mjs
node --test
node --watch --env-file-if-exists=.env src/server.js
```

## Configuration

Copy `.env.example` to `.env` if needed. Settings saved through the web interface take precedence over the initial `BASE_URL` environment value.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local administration listener. |
| `PORT` | `7000` | Local web interface and server port. |
| `PUBLIC_PORT` | `7001` | Loopback gateway used by Funnel. |
| `FUNNEL_HTTPS_PORT` | `8443` | Public HTTPS port: `443`, `8443`, or `10000`. |
| `BASE_URL` | saved origin or local address | Initial addon and subtitle-download origin. |
| `ADMIN_BASE_URL` | unset | Optional origin for an existing private administration proxy. |
| `ADMIN_PASSWORD` | local first-run setup | Optional environment-managed password, 12–1024 characters. |
| `OPEN_BROWSER` | `true` | Set to `false` on a headless server. |
| `DATA_DIR` | source `./data` or installed user data | Persistent data directory. |

The administrator password is hashed with scrypt. Login sessions expire after 12 hours; rate limiting restricts failed login attempts. Uploaded files are validated and stored under generated IDs. The application does not provide video streams.

## Building a release on GitHub

The **Windows release** GitHub Actions workflow validates the source, bundles the official Node runtime and verified Tailscale MSI, builds an Inno Setup installer, installs it on an isolated Windows runner, and checks that the bundled server and web interface start successfully.

To publish a version:

1. Update `package.json`, `CHANGELOG.md`, and `RELEASE-NOTES.md`.
2. Commit and push the source.
3. Create and push a matching version tag:

```powershell
git tag v1.1.0
git push origin v1.1.0
```

The workflow creates the GitHub Release with the `.exe` and `SHA256SUMS.txt` only after the installer checks pass. Manual workflow dispatch builds downloadable Actions artifacts without publishing a version.

For a local Windows build, use a fresh checkout with Node.js 24 LTS and Inno Setup 6 installed:

```powershell
powershell -NoProfile -File scripts/build-windows.ps1
```

See [third-party notices](THIRD_PARTY_NOTICES.md) for bundled dependency licenses. The addon follows the official [Stremio subtitle response](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/subtitles.md) and [manifest](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md) specifications.
