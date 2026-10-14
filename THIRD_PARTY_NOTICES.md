# Third-party notices

The Windows installer bundles an unmodified official Node.js 24 LTS executable and the official Tailscale 1.104.1 Windows MSI. Both artifacts are verified against vendor-published SHA-256 checksums; the Tailscale MSI signature is also checked during the build.

- [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE)
- [Tailscale license](https://github.com/tailscale/tailscale/blob/main/LICENSE)
- [Tailscale service terms](https://tailscale.com/terms)

Full Node.js and Tailscale license files are included in the installed `licenses` directory. Tailscale remains a separate installed product and is not removed by uninstalling Custom Subtitles. Release build metadata records the dependency versions and checksums in `build-info.json`.
