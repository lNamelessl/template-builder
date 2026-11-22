---
title: "Deploy modpack-paste-server"
description: "Paste a Modrinth modpack URL - get a running modded Minecraft server"
category: "Other"
url: https://railway.com/deploy/modpack-paste-serv-1
---

# Deploy modpack-paste-server

Paste a Modrinth modpack URL - get a running modded Minecraft server

**[Deploy modpack-paste-server on Railway](https://railway.com/template/modpack-paste-serv-1)**

Machine-readable deploy manifest (JSON, validated by TemplateCI): https://railway.com/deploy/modpack-paste-serv-1/manifest.json

- **Creator:** Nameless 's Projects
- **Category:** Other

## Template content

### modpack-paste-server

- **Source:** https://github.com/lNamelessl/modpack-paste-server
- **Health check:** health
- **Public domain:** Yes

## Documentation

# Modpack Paste Server

Paste a Modrinth modpack page URL and get a running modded Minecraft server, with the world on a persistent volume and a live readiness page.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/modpack-paste-server)

The template boots ready to play with Cobblemon Fabric on Minecraft 1.21.1. Replace one variable with any other Modrinth pack page and it reinstalls itself. CurseForge page URLs work too once you add your own API key.

## After deploying

1. Open the service domain: the status page shows the phase, the pack, and whether the game is ready yet.
2. In the service, open Settings then Networking, and create a TCP proxy on port 25565.
3. Copy the RCON password printed in the deploy log banner (also saved at /data/.rcon-password).
4. To run a different pack, set MODPACK_URL to another Modrinth pack page in Variables; Railway redeploys automatically.
5. Add the TCP proxy host and port in Minecraft, install the same pack version on your client, and join.

## What is inside

| Capability | How it works |
| --- | --- |
| Pack installer | Upstream itzg image resolves the Modrinth pack, its loader, and its mod list, then boots the server |
| CurseForge support | Detected from the URL; needs your own CF_API_KEY and falls back to a guided setup page when it is missing |
| Persistent world | Railway volume at /data holds world, mods, configs, logs, and the RCON password |
| Liveness route | health returns 200 from the first second, so a long pack download never fails the deploy |
| Readiness route | ready returns 200 only after the JVM prints its Done line, so you know when players can join |
| Status page | Self-contained HTML at the root, polls the two routes, no external calls |
| RCON | Enabled with a per-deploy generated password, seeded once behind a marker on the volume |
| Restart policy | ON_FAILURE with 10 retries, one replica, healthcheck timeout 300 seconds |
| Pinned runtime | itzg/minecraft-server java21 and busybox 1.36 are both digest pinned |

## Honest limits (measured)

| Limit | Detail |
| --- | --- |
| Liveness is not readiness | health answers 200 while the supervisor runs; use ready to know the game booted |
| Default memory | 6G heap. Below 4G many packs crash on world load; Railway bills per minute while it runs |
| First boot time | Pack download plus mod load. A 96 MB mrpack with 200 mods typically needs 2 to 6 minutes |
| One replica | The /data volume cannot be shared, so scaling out is not supported |
| CurseForge is opt in | Anonymous downloads are blocked and keys may not be shared, so a CurseForge URL without CF_API_KEY stops at a guided setup page |
| Pack author choice | Some CurseForge packs disable third-party downloads and cannot be installed until the author re-enables them |
| Java version | The image pins Java 21, which covers Minecraft 1.20.5 through 1.21.x packs. Minecraft 26.x needs a Java 25 image |
| Minecraft 26.x note | For 26.x packs, change the base tag to java25 and redeploy |
| EULA | EULA is set to TRUE, so deploying accepts the Minecraft EULA for your own server |
| Backups | No automated world backups are included |
| TCP proxy | The 25565 proxy is a one time manual dashboard step; it cannot be created by the deploy form |

## Credentials

| Value | Where you get it | Where it lands |
| --- | --- | --- |
| RCON_PASSWORD | Generated for you on first boot, 24 characters | Printed once in the deploy log banner and stored at /data/.rcon-password |
| CF_API_KEY | console.curseforge.com, sign in, then API Keys, then create a key | Railway service variable, passed to the container only, never logged |
| MODPACK_VERSION | The pack page on modrinth.com, under Versions | Railway service variable, optional pin |

# Deploy and Host

Deploy this template and Railway builds one container from a digest pinned Dockerfile: the upstream itzg Minecraft server image plus a static busybox httpd for the status surface. The only input that matters is MODPACK_URL. Everything else (loader detection, mod download, world creation, EULA, ports) is handled inside the container.

Hosting here means one always-on service with a Railway volume mounted at /data. That volume is the whole server state: world saves, mods, configs, server properties, logs, and the RCON password. Redeploys and variable changes keep it, which is why changing packs does not wipe the world.

## About Hosting

The container exposes three ports. Port 8080 serves the status page, the health route, and the ready route, and is what the platform healthcheck targets. Port 25565 is Minecraft game traffic and needs a TCP proxy before players can connect from outside Railway. Port 25575 is RCON for console access and also needs a TCP proxy if you want it.

Memory is the main cost driver. Modded servers keep a large heap resident, so plan on 4 to 8 GB for a real pack. The default is 6 GB and is set through the MEMORY variable. Railway charges by the minute while the service runs, so stopping the service is the fastest way to cut cost between play sessions; the world stays on the volume.

Restarts are handled by the platform restart policy, ON_FAILURE with 10 retries. If a pack fails to install, the container exits, restarts a limited number of times, and the server log at /data/logs/latest.log keeps the reason. Configuration problems that are not crashes (no pack URL, CurseForge without a key) do not exit at all: the supervisor keeps serving a guided status page so the deploy stays healthy while you fix the variable.

## Why Deploy

Setting up a modded server by hand is a compatibility puzzle: pick a loader, match a Minecraft version, pull the right pack release, remove client-only mods, and only then invite friends. This template reduces that to one URL. The pack installer reads the pack manifest, installs exactly the mods and loader the pack declares, and boots the server against them.

The readiness split is the practical difference. Most container templates gate on a port being open, which for Minecraft fires long before the world loads, so the first player to connect is kicked. Here the ready route flips only after the JVM prints its Done line, and the status page shows the phase you are in, so you can tell installing from booting from ready.

It is also honest about the awkward parts. CurseForge needs a key you own, some packs forbid third-party downloads, and Minecraft 26.x needs a newer Java than the pinned image. Each of those produces a plain message with the exact next action instead of a crash loop.

## Common Use Cases

* A weekend friend group that wants a specific CurseForge or Modrinth kitchen-sink pack without monthly managed hosting.
* Testing whether a pack runs on a server at all before committing to a host.
* A private modded world that should stay up intermittently and cost nothing while stopped.
* A modpack developer who wants a throwaway server matching their published pack release to sanity check recipes and spawn behaviour.
* A classroom or LAN style event where one person deploys and shares a single address.

## Dependencies for

Nothing external is required to boot. The default pack is fetched from the public Modrinth API, which needs no key. The container carries its own Java runtime, its own HTTP server, and its own pack installer, so there is no database, no object storage, and no second service.

Two things are optional and user supplied. A CurseForge API key unlocks CurseForge pack URLs. A TCP proxy on port 25565 is what makes the server reachable from Minecraft clients outside Railway.

### Deployment Dependencies

| Dependency | Required | Notes |
| --- | --- | --- |
| Modrinth public API | Yes for Modrinth packs | No key, no account, fetched at container start |
| CurseForge API key | Only for CurseForge pack URLs | Created at console.curseforge.com under API Keys, per account, non transferable |
| Railway volume at /data | Yes | Holds world, mods, configs, logs and the RCON password |
| TCP proxy on 25565 | Yes for players | Created once in the service Networking tab |
| TCP proxy on 25575 | Optional | Only if you want an external RCON console |
| Outbound network | Yes | Pack and mod downloads happen at runtime |

## Similar templates

- [Rocky Linux](https://railway.com/deploy/rocky-linux) — Hosted Rocky Linux 9 workspace with SSH and persistent storage. 🚀
- [Foundry Virtual Tabletop](https://railway.com/deploy/X5tR6G) — Self-hosted virtual tabletop for role-playing games (license required)
- [Double Commander in your browser](https://railway.com/deploy/double-commander-in-your-browser) — The Double Commander file manager in the cloud, from any device

Open this page in a browser: https://railway.com/deploy/modpack-paste-serv-1
