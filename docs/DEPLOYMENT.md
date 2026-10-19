# Deployment Guide

Complete guide for deploying RBS' Planning Poker to various environments.

Maven builds produce `planningpoker-<version>.jar`. Repository, service and
container examples use `planning-poker`; internal names use `planningpoker`.
Commands below are deployment examples, not an automatic migration of existing
accounts, registry packages or filesystem paths. FTPS room paths are unchanged.

---

## Table of Contents

1. [Deployment Overview](#deployment-overview)
2. [Production Deployment (Koyeb)](#production-deployment-koyeb)
3. [Docker Deployment](#docker-deployment)
4. [Manual Deployment](#manual-deployment)
5. [Environment Configuration](#environment-configuration)
6. [Monitoring & Health Checks](#monitoring--health-checks)
7. [Troubleshooting](#troubleshooting)

---

## Deployment Overview

### Current Production Setup

**Hosting:** Koyeb (PaaS)  
**DNS:** Cloudflare DNS-only; HTTP proxy/CDN disabled
**Persistence:** FTPS (DomainFactory)  
**Domain:** https://planning-poker.at/

### Deployment Architecture

```
┌─────────────────────────────────────────────┐
│               Cloudflare                     │
│  - Authoritative DNS                         │
│  - Apex CNAME flattening                     │
│  - No HTTP proxy/CDN in production path      │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│               Koyeb                           │
│  - Docker Container                          │
│  - HTTPS/WSS and TLS                          │
│  - Health Checks                             │
│  - Deployment behavior set in Koyeb dashboard│
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│        FTPS File Storage                     │
│  (DomainFactory)                             │
│  - Room Snapshots                            │
└──────────────────────────────────────────────┘
```

---

## Production Deployment (Koyeb)

### Prerequisites

1. **Koyeb Account:** https://www.koyeb.com/
2. **GitHub Repository:** Connected to Koyeb
3. **Docker Hub (Optional):** For pre-built images
4. **Authoritative DNS access:** Currently Cloudflare DNS-only; do not enable its HTTP proxy as part of a routine deployment

---

### Initial Setup

#### 1. Fork/Clone Repository

Ensure code is in a GitHub repository accessible to Koyeb.

#### 2. Configure Koyeb

**Via Web UI:**

1. Log in to Koyeb
2. Create New App
3. Select "GitHub" as source
4. Choose repository: `nox-vobiscum/planning-poker`
5. Select branch: `main`
6. Build method: **Dockerfile**
7. Dockerfile path: `./Dockerfile`
8. Port: `8080`
9. Health check: `/healthz`

**Environment Variables:**
```
SPRING_PROFILES_ACTIVE=prod
DF_FTP_HOST=<ftps-host>
DF_FTP_USER=<ftps-user>
DF_FTP_PASS=<ftps-password>
DF_FTP_BASE=rooms
```

**Via `koyeb.yaml`:**

The repository includes `koyeb.yaml` for declarative configuration:

```yaml
services:
  - name: planning-poker
    type: web
    docker:
      context: .
      dockerfile: Dockerfile
    env:
      - key: SPRING_PROFILES_ACTIVE
        value: prod
    ports:
      - port: 8080
        protocol: http
    routes:
      - path: /
```

Deploy using Koyeb CLI:
```bash
koyeb app create planning-poker --git github.com/nox-vobiscum/planning-poker
```

---

### Continuous Deployment

**Automatic deployments on push to `main`:**

1. Push code to GitHub
2. Koyeb detects changes
3. Builds Docker image
4. Runs health checks
5. Activates the deployment according to the Koyeb service settings

Do not assume that this application can use overlapping or multiple active
instances safely. Live rooms, participant identity registries, proof hashes,
connection ownership and leases are process-local. A replacement process creates
new room-instance identities; existing browser proofs cannot resume there even if
room snapshots restore other game data. Plan this release as an interruption of
all active rooms.

**Manual deployment:**
```bash
git push origin main
# Koyeb auto-deploys
```

---

### Rollback

**Via Web UI:**
1. Go to App → Deployments
2. Select previous deployment
3. Click "Redeploy"

**Via CLI:**
```bash
koyeb deployment list --app planning-poker
koyeb deployment redeploy <deployment-id>
```

---

### Scaling

**Auto-scaling (Koyeb):**
- Configured in Koyeb dashboard
- Scales based on CPU/memory/requests

The checked-in `koyeb.yaml` does not declare replica counts, autoscaling, sticky
sessions, deployment overlap or drain behavior. The active dashboard settings were
not inspected in this documentation step. Until a shared room/identity authority is
implemented, configure exactly one active application replica and do not enable
autoscaling. Sticky routing alone would not make failover or a new deployment able
to validate proofs issued by another process.

**Manual scaling:**
```bash
koyeb service scale planning-poker --min 1 --max 1
```

Treat this command as an example only; verify the current Koyeb CLI syntax and the
active service settings before the approved rollout.

---

## Docker Deployment

### Building the Image

**Multi-stage Dockerfile** (included in repository):

```dockerfile
FROM maven:3.9.6-eclipse-temurin-25 AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN ./mvnw package -DskipTests

FROM eclipse-temurin:25-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
```

**Build:**
```bash
docker build -t planning-poker:latest .
```

**Build with custom tag:**
```bash
docker build -t planning-poker:1.4.0 .
```

---

### Running Locally

**Basic run:**
```bash
docker run -p 8080:8080 planning-poker:latest
```

**With environment variables:**
```bash
docker run -p 8080:8080 \
  -e SPRING_PROFILES_ACTIVE=prod \
  -e DF_FTP_HOST=ftp.example.com \
  -e DF_FTP_USER=user \
  -e DF_FTP_PASS=pass \
  planning-poker:latest
```

**With environment file:**
```bash
docker run -p 8080:8080 --env-file .env planning-poker:latest
```

**.env example:**
```
SPRING_PROFILES_ACTIVE=prod
DF_FTP_HOST=ftp.example.com
DF_FTP_USER=user
DF_FTP_PASS=pass
```

---

### Docker Compose (Optional)

**docker-compose.yml:**
```yaml
version: '3.8'

services:
  planning-poker:
    build: .
    ports:
      - "8080:8080"
    environment:
      - SPRING_PROFILES_ACTIVE=prod
      - DF_FTP_HOST=${DF_FTP_HOST}
      - DF_FTP_USER=${DF_FTP_USER}
      - DF_FTP_PASS=${DF_FTP_PASS}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped
```

**Run:**
```bash
docker-compose up -d
```

**Stop:**
```bash
docker-compose down
```

---

### Pushing to Registry

**Docker Hub:**
```bash
docker tag planning-poker:latest yourusername/planning-poker:latest
docker push yourusername/planning-poker:latest
```

**GitHub Container Registry:**
```bash
docker tag planning-poker:latest ghcr.io/nox-vobiscum/planning-poker:latest
docker push ghcr.io/nox-vobiscum/planning-poker:latest
```

---

## Manual Deployment

### Build Executable JAR

```bash
./mvnw clean package -DskipTests
```

**Output:** `target/planningpoker-1.4.0-SNAPSHOT.jar`

---

### Transfer to Server

**SCP:**
```bash
scp target/planningpoker-*.jar user@server:/opt/planningpoker/
```

**SFTP:**
```bash
sftp user@server
put target/planningpoker-*.jar /opt/planningpoker/
```

---

### Run on Server

**Direct execution:**
```bash
java -jar /opt/planningpoker/planningpoker-1.4.0-SNAPSHOT.jar
```

**With profile:**
```bash
java -jar planningpoker.jar --spring.profiles.active=prod
```

**With JVM options:**
```bash
java -Xmx512m -Xms256m -jar planningpoker.jar
```

---

### Systemd Service (Linux)

**Create service file:** `/etc/systemd/system/planningpoker.service`

```ini
[Unit]
Description=RBS' Planning Poker Estimation App
After=network.target

[Service]
Type=simple
User=planningpoker
WorkingDirectory=/opt/planningpoker
ExecStart=/usr/bin/java -jar /opt/planningpoker/planningpoker.jar
Restart=on-failure
RestartSec=10
Environment="SPRING_PROFILES_ACTIVE=prod"
Environment="DF_FTP_HOST=ftp.example.com"
Environment="DF_FTP_USER=user"
Environment="DF_FTP_PASS=pass"

[Install]
WantedBy=multi-user.target
```

**Enable and start:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable planningpoker
sudo systemctl start planningpoker
```

**Check status:**
```bash
sudo systemctl status planningpoker
```

**View logs:**
```bash
sudo journalctl -u planningpoker -f
```

---

## Environment Configuration

### Configuration Profiles

**Available profiles:**
- `default` - Local development (in-memory)
- `local` - Local development with optional persistence
- `e2e` - E2E testing profile
- `prod` - Production profile

**Activate profile:**
```bash
# JVM arg
java -jar planningpoker.jar --spring.profiles.active=prod

# Environment variable
export SPRING_PROFILES_ACTIVE=prod
java -jar planningpoker.jar

# Docker
docker run -e SPRING_PROFILES_ACTIVE=prod planning-poker
```

---

### Environment Variables

#### Core Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SPRING_PROFILES_ACTIVE` | No | `default` | Active Spring profile |
| `SERVER_PORT` | No | `8080` | HTTP port |

#### Persistence

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DF_FTP_HOST` | If FTPS | - | FTPS server hostname |
| `DF_FTP_PORT` | No | `21` | FTPS server port |
| `DF_FTP_USER` | If FTPS | - | FTPS username |
| `DF_FTP_PASS` | If FTPS | - | FTPS password |
| `DF_FTP_BASE` | No | `rooms` | Base directory for snapshots |

#### Features

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `features.persistentRooms.enabled` | No | `false` | Enable persistence |
| `features.persistentRooms.snapshot.enabled` | No | `true` | Enable snapshots |
| `features.persistentRooms.snapshot.debounceMs` | No | `1500` | Debounce delay (ms) |

#### Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ROOM_BCRYPT_COST` | No | `10` | BCrypt cost factor |
| `ROOM_PW_PEPPER` | No | - | Password pepper (optional) |

---

### application.properties vs. Environment Variables

**Priority (highest to lowest):**
1. Environment variables
2. Profile-specific properties (`application-prod.properties`)
3. Default properties (`application.properties`)

**Example:**
```properties
# application.properties
features.persistentRooms.enabled=false

# application-prod.properties
features.persistentRooms.enabled=true

# Environment variable (highest priority)
FEATURES_PERSISTENTROOMS_ENABLED=true
```

---

## Monitoring & Health Checks

### Health Check Endpoint

**Endpoint:** `/healthz`

**Response (Healthy):**
```json
{
  "status": "UP"
}
```
**Status Code:** `200 OK`

**Response (Unhealthy):**
```json
{
  "status": "DOWN"
}
```
**Status Code:** `503 Service Unavailable`

---

### Automated Health Monitoring

RBS' Planning Poker uses automated health monitoring to ensure availability and prevent cold starts on free-tier hosting platforms.

#### GitHub Actions Health Check

**Location:** `.github/workflows/health-monitoring.yml`

**Purpose:**
- Periodic health endpoint monitoring
- Prevents cold starts during active hours
- Provides basic uptime verification

**Configuration:**
- **Interval:** Every 30 minutes (UTC)
- **Active hours:** 06:00-23:00 Europe/Vienna (DST-aware)
- **Endpoint:** `https://planning-poker.at/healthz`
- **Timeout:** 8 seconds

**Manual trigger:**
```bash
# Via GitHub Actions UI
# Or using GitHub CLI:
gh workflow run health-monitoring.yml
```

**Customize active hours:**
```yaml
# .github/workflows/health-monitoring.yml
if [ "$HOUR" -lt 6 ] || [ "$HOUR" -gt 23 ]; then
  # Adjust hours as needed
fi
```

**Weekend skip (optional):**
```yaml
# Uncomment in workflow file:
if [ "$DOW" -gt 5 ]; then echo "Weekend → skip"; exit 0; fi
```

**Resource usage:** ~15 GitHub Actions minutes/month

#### External Uptime Monitoring (Recommended)

**Status:** ⏳ Planned (see [BACKLOG.md](BACKLOG.md))

For production deployments, consider dedicated uptime monitoring services:

**Recommended: UptimeRobot (Free Tier)**
- ✅ 5-minute check intervals (faster than GitHub Actions)
- ✅ 50 monitors included
- ✅ Email alerts on downtime
- ✅ Public status page
- ✅ Response time tracking
- ✅ 24/7 monitoring

**Setup steps:**
1. Create account at [uptimerobot.com](https://uptimerobot.com)
2. Add HTTP(s) monitor:
   - **URL:** `https://planning-poker.at/healthz`
   - **Type:** HTTP(s)
   - **Interval:** 5 minutes
   - **Alert contacts:** Your email
3. Configure public status page (optional)
4. Decide: Keep GitHub Action as redundancy or disable

**Alternatives:**
- **Healthchecks.io** - 1-minute intervals, 20 monitors free
- **Better Uptime** - 30-second intervals, 30-day trial
- **StatusCake** - 5-minute intervals, unlimited monitors free

**Benefits over GitHub Actions:**
- Faster check intervals (5 min vs 30 min)
- Dedicated monitoring dashboard
- Downtime alerts and notifications
- Historical uptime statistics
- Independent from GitHub availability

**Migration decision factors:**
- For hobby/low-traffic: GitHub Actions sufficient
- For production/critical: External monitoring recommended
- Hybrid approach: Both for redundancy

---

### Actuator Endpoints (Optional)

**Enable Actuator:**
```properties
management.endpoints.web.exposure.include=health,info,metrics
```

**Endpoints:**
- `/actuator/health` - Detailed health
- `/actuator/info` - App info
- `/actuator/metrics` - Metrics

**Secure Actuator:**
```properties
management.endpoints.web.base-path=/actuator
management.endpoints.web.exposure.include=health
```

---

### Logging

**Configure logging level:**
```properties
# application-prod.properties
logging.level.root=INFO
logging.level.com.example.planningpoker=INFO

# Log to file
logging.file.name=/var/log/planningpoker/app.log
logging.file.max-size=10MB
logging.file.max-history=30
```

**Via environment:**
```bash
export LOGGING_LEVEL_COM_EXAMPLE_PLANNINGPOKER=DEBUG
```

---

### Metrics & Monitoring

**Recommended tools:**
- **Prometheus** - Metrics collection
- **Grafana** - Dashboards
- **Sentry** - Error tracking
- **Datadog** - APM

**Enable Prometheus endpoint:**
```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
```

```properties
management.endpoints.web.exposure.include=prometheus
```

**Scrape endpoint:**
```
GET /actuator/prometheus
```

---

## Production DNS Configuration

### DNS Setup

The production hostname is `planning-poker.at` (zone apex, usually shown as `@`).
Retain its verified DNS target and TLS setup. Use only provider-confirmed records;
do not infer a Koyeb IP or add a subdomain alias as part of a naming cleanup.
Cloudflare is authoritative DNS only. Its HTTP proxy, CDN, cache, TLS settings
and WAF are not part of the active production request path.

---

### TLS and request path

Koyeb terminates HTTPS/WSS and manages the certificate for
`planning-poker.at`. Do not enable the Cloudflare HTTP proxy during routine
deployment or documentation maintenance. Treat any future proxy/CDN activation
as a separate infrastructure change with WebSocket and cache validation.

---

## Backup & Recovery

### Backup FTPS Snapshots

**Manual backup:**
```bash
# Connect via FTPS client
lftp -u $DF_FTP_USER,$DF_FTP_PASS ftps://$DF_FTP_HOST
mirror rooms/ ./backup/rooms/
```

**Automated backup (cron):**
```bash
#!/bin/bash
# backup-ftps.sh
lftp -u $DF_FTP_USER,$DF_FTP_PASS ftps://$DF_FTP_HOST <<EOF
mirror rooms/ /backup/planning-poker-$(date +%Y%m%d)/
bye
EOF
```

**Crontab:**
```cron
0 2 * * * /opt/scripts/backup-ftps.sh
```

---

### Database Backup (Future)

When database persistence is implemented:

```bash
pg_dump -h $DB_HOST -U $DB_USER planningpoker > backup-$(date +%Y%m%d).sql
```

---

### Disaster Recovery

**Recovery steps:**

1. **Redeploy application:**
   ```bash
   koyeb deployment redeploy <last-good-deployment-id>
   ```

2. **Restore FTPS snapshots:**
   ```bash
   lftp -u $DF_FTP_USER,$DF_FTP_PASS ftps://$DF_FTP_HOST
   mirror -R ./backup/rooms/ rooms/
   ```

3. **Verify health:**
   ```bash
   curl https://planning-poker.at/healthz
   ```

---

## Troubleshooting

### Deployment Fails

**Check build logs:**
```bash
koyeb deployment logs <deployment-id>
```

**Common issues:**
- Missing dependencies (Maven cache issue)
- Docker build timeout
- Out of memory during build

**Solutions:**
- Re-trigger build
- Increase build resources (Koyeb settings)
- Optimize Dockerfile (multi-stage caching)

---

### Application Won't Start

**Check logs:**
```bash
koyeb service logs planning-poker --tail
```

**Common issues:**
- Missing environment variables
- Port binding conflict
- Configuration errors

**Solutions:**
- Verify all required env vars set
- Check `application-prod.properties`
- Validate YAML/properties syntax

---

### WebSocket Connection Fails

**Check allowed origins:**
```properties
app.websocket.allowed-origins=https://planning-poker.at
```

**Cloudflare WebSocket:**
- Ensure Cloudflare WebSocket support is enabled (usually automatic)
- Check for firewall rules blocking WebSocket

---

### FTPS Connection Issues

**Test connection:**
```bash
curl -v -k --ftp-ssl ftps://$DF_FTP_HOST --user $DF_FTP_USER:$DF_FTP_PASS
```

**Common issues:**
- Firewall blocking port 21
- Passive mode issues
- TLS/SSL version mismatch

**Solutions:**
```properties
app.storage.ftps.passive=true
app.storage.ftps.implicit-mode=false
app.storage.ftps.prefer-ipv4=true
```

---

### High Memory Usage

**Monitor memory:**
```bash
curl http://localhost:8080/actuator/metrics/jvm.memory.used
```

**Increase heap size:**
```bash
java -Xmx512m -jar planningpoker.jar
```

**Docker:**
```dockerfile
ENTRYPOINT ["java", "-Xmx512m", "-jar", "app.jar"]
```

---

### Slow Response Times

**Check metrics:**
```bash
curl http://localhost:8080/actuator/metrics/http.server.requests
```

**Optimize:**
- Review static-asset cache headers before introducing an external CDN
- Review database queries (if applicable)
- Consider adding Redis for session storage (future)

---

## Security Checklist

- [ ] HTTPS/WSS and the custom-domain certificate are healthy in Koyeb
- [ ] Allowed origins configured correctly
- [ ] Sensitive environment variables not in code
- [ ] Actuator endpoints secured or disabled
- [ ] Logs don't contain sensitive data
- [ ] Dependencies up to date (`mvn versions:display-dependency-updates`)
- [ ] Security headers configured (CSP, X-Frame-Options, etc.)
- [ ] Any optional rate limiting is documented and tested with WebSockets
- [ ] Regular backups scheduled

---

## Performance Checklist

- [ ] Response compression verified at the active serving layer
- [ ] Static-asset cache headers verified
- [ ] Heap size appropriately configured
- [ ] Connection pooling configured (if applicable)
- [ ] Unnecessary debug logging disabled
- [ ] Health check interval reasonable (30s)
- [ ] Exactly one active replica confirmed; auto-scaling disabled for process-local rooms/identity

---

## Rollout Checklist

### Participant identity migration release

This rollout replaces the legacy browser-generated CID admission scheme. Bootstrap
removes obsolete `pp-cid` and `pp-pf-ok:*` session data. There is no compatibility
fallback: browsers without a valid version-2 proof must join deliberately and get a
new participant identity. Identity proofs are not part of FTPS snapshots.

#### 2026-10-19 production release record

- Release commit: `486f087` on `main`.
- Previous production commit and rollback tag:
  `e6b3871` / `pre-participant-identity-rejoin-20261019`.
- Pre-production regression: 68/68 Java tests; 299 Playwright cases passed with
  zero failures. After correcting the WebKit project assignment, all 24 WebKit
  menu-focus cases and both Chromium controls passed.
- The Koyeb dashboard was manually confirmed healthy after deployment and showed
  one of one instances running. Dashboard-only autoscaling, overlap and drain
  settings remain operator-controlled and are not inferred from repository files.
- The real installed-iPhone PWA rejoin scenario remains an explicit manual
  post-deployment acceptance gate.

#### Final approval gate

- [ ] Confirm the feature branch is reviewed, merged by the approved process and
      the exact release commit is recorded.
- [ ] Run the complete Java and Playwright regression suites as a separate gate;
      archive commands, commit, engine versions and results.
- [ ] Confirm from the Koyeb dashboard that the service has exactly one active
      replica, autoscaling is disabled, and record the actual deployment overlap,
      connection-drain and rollback behavior. These facts are not in `koyeb.yaml`.
- [ ] Review production environment variables, allowed WebSocket origin, health
      check `/healthz`, FTPS setting and rollback target without exposing secrets.
- [ ] Announce a maintenance window and tell users that existing rooms/connections
      may be interrupted and legacy participants may need to join again.
- [ ] If persistent rooms are enabled in the actual environment, back up snapshots
      and verify restore access. Do not claim persistence is enabled based on docs;
      both checked-in prod properties and `koyeb.yaml` currently default it off.

#### Controlled deployment

- [ ] Verify no important room is active, or obtain explicit acceptance that it can
      be interrupted. Do not rely on a rolling overlap to preserve participation.
- [ ] Push/merge only after explicit approval; watch the Koyeb build and health gate.
- [ ] Record old and new deployment IDs plus the release commit before traffic moves.
- [ ] Confirm one healthy active deployment and no unintended second replica.
- [ ] If health, WebSocket admission or identity smoke tests fail, redeploy the
      recorded last-good deployment. Rollback also changes the process-local room
      instance and cannot restore current connection ownership.

#### Production smoke tests

- [ ] `/healthz`, home, invite and room creation respond through HTTPS.
- [ ] Two separate browsers join one unique test room; voting and roster updates
      cross the production WSS connection.
- [ ] Refresh, Back and a short network interruption resume the same participant;
      vote and spectator status remain unchanged and no duplicate row appears.
- [ ] A concurrent second tab cannot take over an active participant.
- [ ] Host transfer survives former-host reconnect; guest host actions remain denied.
- [ ] Explicit leave permits a fresh join; kick and room closure prevent old-proof
      resume; recreating the same room code rejects the previous room proof.
- [ ] Check application logs for identity tokens or raw proof payloads. None may be
      present.

#### Real iPhone installed-PWA gate

- [ ] Record iPhone model, iOS version, PWA install state and release commit.
- [ ] Vote and toggle spectator/participation, fully close and reopen the PWA after
      each state, and confirm the same single participant and retained state.
- [ ] Suspend beyond the reconnect window and confirm authenticated resume.
- [ ] Test concurrent Safari/PWA ownership, host transfer without role reclamation,
      explicit leave, kick and recreated-room rejection.
- [ ] Record observed results. Any failure blocks final release acceptance and must
      not be replaced by a name-based or client-only workaround.

---

## References

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) - Development guide
- [API.md](API.md) - API reference
- [BRIEFING.md](BRIEFING.md) - Project overview

**External Resources:**
- [Koyeb Documentation](https://www.koyeb.com/docs)
- [Cloudflare Docs](https://developers.cloudflare.com/)
- [Spring Boot Deployment Guide](https://docs.spring.io/spring-boot/docs/current/reference/html/deployment.html)
