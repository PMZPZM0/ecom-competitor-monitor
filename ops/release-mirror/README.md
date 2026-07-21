# Release mirror

The desktop client checks GitHub Releases for version metadata and uses the
project mirror for the selected installer. GitHub remains the fallback URL.

The production mirror is served from:

```text
https://jvsppl.vip/ecom-monitor/releases/<tag>/<asset>
```

`sync-release.sh` polls the public GitHub Releases API, accepts only the three
expected desktop artifacts, verifies their GitHub SHA-256 digests, and publishes
`latest.json` atomically. The timer runs every five minutes and retains the
three newest mirrored releases.

Server layout:

```text
/srv/ecom-monitor/latest.json
/srv/ecom-monitor/releases/<tag>/
/usr/local/bin/sync-ecom-monitor-release
```

Install the script and systemd units with root ownership, insert
`Caddyfile.snippet` before the site's fallback handler, validate Caddy, then
enable `ecom-monitor-release-sync.timer`. The service runs as the unprivileged
`ubuntu` user, which owns `/srv/ecom-monitor`.
