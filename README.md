# MCI Pipeline Intelligence Agent for Slack

A production-grade Slack bot that monitors Marketing Cloud Intelligence (Datorama) pipeline health, fires intelligent alerts, enables auto-repair of failed pipelines, handles OAuth token re-authentication, and provides an AI-powered canvas for natural language pipeline Q&A.

---

## Architecture

```
Slack (Socket Mode)
    │
    ├── @mention / DM → messageHandlers.js → anthropicAgent.js (Claude claude-sonnet-4-20250514)
    ├── Button clicks  → actionHandlers.js  → repairService.js → mciClient.js
    ├── Slash commands → shortcuts.js
    └── Scheduler      → scheduler.js → postMorningSummary / pollForFailures / pollTokenExpiry
                              │
                         mciClient.js (MCI REST API)
                              │
                         Datorama / Marketing Cloud Intelligence
```

### Key files

| File | Purpose |
|---|---|
| `src/index.js` | Entry point — boots Slack Bolt (Socket Mode) + cron scheduler |
| `src/api/mciClient.js` | All MCI API calls: pipelines, connectors, runs, logs, reprocess |
| `src/agent/anthropicAgent.js` | Claude claude-sonnet-4-20250514 chat + repair plan generation + summary narrative |
| `src/services/repairService.js` | Auto-repair strategies: Meta API migration, rate limit, token, generic |
| `src/services/scheduler.js` | Morning summary cron + failure polling every 15 min + token check every 6h |
| `src/slack/blockBuilders.js` | All Slack Block Kit layouts (messages, modals, progress updates) |
| `src/slack/messageHandlers.js` | @mention and DM routing |
| `src/slack/actionHandlers.js` | Button clicks, modal submissions, OAuth re-auth, repair confirm |
| `src/slack/shortcuts.js` | Slash commands: /mci-status, /mci-repair, /mci-ask, /mci-summary |

---

## Setup

### 1. Create the Slack App

1. Go to https://api.slack.com/apps → Create New App → From scratch
2. Name it `MCI Pipeline Agent`
3. Under **Socket Mode** → Enable Socket Mode → Generate an App-Level Token with `connections:write` scope → copy as `SLACK_APP_TOKEN`
4. Under **OAuth & Permissions** → Bot Token Scopes, add:
   - `chat:write`
   - `chat:write.public`
   - `reactions:write`
   - `reactions:read`
   - `channels:history`
   - `groups:history`
   - `im:history`
   - `im:write`
   - `commands`
   - `users:read`
   - `views:open`
   - `views:publish`
5. Install app to workspace → copy `Bot User OAuth Token` as `SLACK_BOT_TOKEN`
6. Under **Basic Information** → App Credentials → copy `Signing Secret` as `SLACK_SIGNING_SECRET`

### 2. Register slash commands

Under **Slash Commands** in your Slack app settings, create:

| Command | Description |
|---|---|
| `/mci-status` | Full pipeline health overview |
| `/mci-repair <name>` | Repair a pipeline by name |
| `/mci-ask <question>` | Ask the AI agent anything |
| `/mci-summary` | Force-post a morning summary now |

Set Request URL to `https://your-server.com/slack/events` (not needed for Socket Mode).

### 3. Enable event subscriptions

Under **Event Subscriptions** → Enable Events → Subscribe to bot events:
- `app_mention`
- `message.im`
- `message.channels`

### 4. Install dependencies

```bash
npm install
```

### 5. Configure environment

```bash
cp .env.example .env
# Edit .env with your tokens, API keys, and workspace IDs
```

Required variables:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
SLACK_PIPELINE_CHANNEL=C0...     # Right-click #mci-pipeline-bot > Copy Channel ID
SLACK_ALERTS_CHANNEL=C0...       # Right-click #pipeline-alerts > Copy Channel ID
ANTHROPIC_API_KEY=sk-ant-...
MCI_API_BASE_URL=https://api.mci.salesforce.com/v1
MCI_API_KEY=...
MCI_WORKSPACE_IDS=ws-1,ws-2,...
TIMEZONE=Asia/Jerusalem
```

### 6. Run

```bash
# Development
npm run dev

# Production
npm start
```

---

## Repair Strategies

The agent auto-detects the failure type and applies the right strategy:

| Error type | Detection | Strategy |
|---|---|---|
| Meta Graph API v16 deprecated | `API_VERSION_DEPRECATED` error or "v16" in message | Remap fields → migrate endpoint to v19 → test run → reprocess |
| OAuth token expired | `OAUTH_TOKEN_EXPIRED` or "token" in message | Prompt user for re-auth via Slack OAuth flow |
| Rate limit exceeded | `RATE_LIMIT_EXCEEDED` | Wait 30s → reprocess missing window |
| Field not found | `FIELD_NOT_FOUND` | Apply Meta field migration map if Meta connector, else generic |
| Generic failure | All other codes | Test run → reprocess if test passes |

### Meta field migration map (Graph API v16 → Marketing API v19)

| Deprecated field | New field |
|---|---|
| `insights.reach` | `media_view_count` |
| `insights.impressions` | `impression_count` |
| `insights.spend` | `spend` |
| `insights.clicks` | `inline_link_clicks` |
| `insights.video_views` | `video_p100_watched_actions` |
| `post_impressions` | `media_view_count` |
| `post_impressions_unique` | `media_reach` |
| `page_views_total` | `page_views` |
| `page_engaged_users` | `page_engaged_users_v2` |

---

## Scheduler

| Job | Schedule | What it does |
|---|---|---|
| Morning summary | Weekdays 8:00 AM (configurable) | Posts full health summary + per-pipeline failure cards |
| Failure polling | Every 15 minutes | Detects new failures since last check, posts alerts |
| Token expiry check | Every 6 hours | Alerts on connectors expiring within 2 days |

---

## AI Agent (Claude)

The `/mci-ask` command, @mention responses, and canvas chat all use Claude claude-sonnet-4-20250514 with:
- **Live pipeline context** injected into the system prompt on every request (health score, failed pipelines, warnings, expiring tokens)
- **Per-user conversation history** maintained in memory for multi-turn Q&A (last 10 turns)
- **Repair plan generation** — Claude generates step-by-step repair plans tailored to the specific error type
- **Morning narrative** — Claude writes a 2-sentence human-readable summary of overnight pipeline health

---

## Deployment (Production)

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
CMD ["node", "src/index.js"]
```

```bash
docker build -t mci-pipeline-agent .
docker run -d --env-file .env mci-pipeline-agent
```

### Environment notes for production

- Replace in-memory caches (`node-cache`, conversation history `Map`) with **Redis**
- Add a **database** (PostgreSQL) to persist snooze state and repair history
- Store `SLACK_BOT_TOKEN` and `ANTHROPIC_API_KEY` in **AWS Secrets Manager** or **Vault**
- Use a **message queue** (SQS, RabbitMQ) for repair jobs instead of direct async calls
- Deploy behind a load balancer if using webhook mode instead of Socket Mode

---

## Extending

**Add a new connector type repair strategy:**
1. Add detection logic in `repairService.js → inferRepairStrategy()`
2. Implement `repairMyConnector(pipeline, onProgress)` function
3. Add the case to the `switch` in `executeRepair()`

**Add a new slash command:**
1. Register it in `src/slack/shortcuts.js`
2. Add it to the Slack app settings under Slash Commands

**Add a new metric to the morning summary:**
1. Compute it in `mciClient.js → getHealthSummary()`
2. Add a block in `blockBuilders.js → buildMorningSummaryBlocks()`
