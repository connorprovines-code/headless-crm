# Headless CRM

AI-orchestrated CRM where humans never touch the database directly. Supabase backend + natural language CLI interface.

## Architecture

```
┌──────────────────────────────────────────────────┐
│              SUPABASE (PostgreSQL)               │
│  - Companies, Contacts, Deals                    │
│  - Interactions, Signals, Tasks                  │
│  - Agent audit logs                              │
└──────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│               CLI TOOL (Phase 1)                 │
│  - Natural language → database operations        │
│  - Claude-powered intent parsing                 │
└──────────────────────────────────────────────────┘
```

## Setup

### 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Go to SQL Editor and run the schema in `supabase/migrations/001_initial_schema.sql`
3. Get your project URL and service role key from Settings > API

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Supabase and Anthropic credentials
```

### 3. Install and Run

```bash
cd cli
npm install
npm start
```

## Usage

The CLI accepts natural language commands:

```
> add company Acme Corp, they do B2B SaaS, about 50 employees
Created Acme Corp (B2B SaaS, 11-50 employees). Want me to add a contact there?

> yeah, Mike Smith, VP Sales, mike@acme.com
Created contact: Mike Smith at Acme Corp.

> just had a great call with Mike, he wants to see pricing next week
Logged call with Mike Smith - positive sentiment. Created follow-up task for pricing.

> who should I call today?
Here's your call list for today:
1. Mike Smith @ Acme Corp (score: 0) - Follow up on pricing

> brief me on Acme
**Acme Corp** (Score: 0)
B2B SaaS | 11-50 employees

**Contacts:**
- Mike Smith, VP Sales

**Recent Activity:**
- Call: positive, wants pricing

**Open Tasks:**
- Follow up on pricing
```

## Schema

Core tables:
- `teams` / `users` - Multi-tenant support
- `companies` - Organizations you're selling to
- `contacts` - People at those companies
- `deals` - Opportunities with stages and values
- `interactions` - Calls, emails, meetings, etc.
- `signals` - Engagement events (email opens, clicks, etc.)
- `tasks` - Follow-ups and action items
- `agent_logs` - Audit trail for all AI actions

## Roadmap

- [ ] **Phase 2**: Agent pipeline (SDR enrichment, scoring, task generation)
- [ ] **Phase 3**: Slack bot integration
- [ ] **Phase 4**: Webhook ingestion (email, calendar)
- [ ] **Phase 5**: Morning digest / notifications

## License

MIT
