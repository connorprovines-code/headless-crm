# Headless CRM - Architecture & Roadmap

## TL;DR

**What**: AI-orchestrated CRM where humans never touch the database directly. Supabase backend + local CLI tool for natural language interaction.

**Phase 1 deliverables**:
1. GitHub repo `headless-crm`
2. Supabase schema (9 tables: teams, users, companies, contacts, deals, interactions, signals, tasks, agent_logs)
3. Node.js CLI tool with Claude-powered natural language interface

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│              SUPABASE (PostgreSQL)               │
│  - Core entities (companies, contacts, deals)   │
│  - Interaction log (calls, emails, meetings)    │
│  - Signals table                                │
│  - Agent action log (audit trail)               │
│  - Users/teams (multi-user ready)               │
└──────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│            LOCAL CLI TOOL (Phase 1)              │
│  - Natural language queries → SQL               │
│  - Read: "show me hot leads" → scored list      │
│  - Write: "log call with Mike at Acme"          │
│  - Uses Claude API + Supabase JS client         │
└──────────────────────────────────────────────────┘
                       │
                       ▼ (future phases)
┌──────────────────────────────────────────────────┐
│               AGENT PIPELINE                     │
│  ┌─────────────┐    ┌─────────────┐             │
│  │  SDR Agent  │───▶│Score Agent  │             │
│  │ (enriches)  │    │(re-scores)  │             │
│  └─────────────┘    └─────────────┘             │
│         │                  │                    │
│         ▼                  ▼                    │
│  ┌─────────────────────────────────┐            │
│  │      Task Generation Agent      │            │
│  │  (creates follow-ups, alerts)   │            │
│  └─────────────────────────────────┘            │
└──────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│              SLACK BOT (Phase 3)                 │
│              WEBHOOK WORKERS (Phase 3)          │
└──────────────────────────────────────────────────┘
```

## Agent Pipeline Model (Future)

Agents are **event-driven** and **chained**:

1. **SDR Agent**: Triggered on new contact/company creation or interval. Enriches data, adds signals.
2. **Scoring Agent**: Triggered after SDR Agent acts, or on interval. Recalculates scores based on all signals/interactions.
3. **Task Agent**: Triggered after Scoring Agent. Generates/updates tasks based on scores and rules.
4. **Notification Agent**: Pushes relevant updates to Slack, email, etc.

Each agent writes to `agent_logs` so we have full audit trail of what happened and why.

**For Phase 1**: No agents yet. Manual input via CLI, scores set manually. Schema supports the agent model, but we're just populating data directly.

---

## Schema Overview

### Core Tables

| Table | Purpose |
|-------|---------|
| `teams` | Multi-tenant support |
| `users` | Team members, linked to Supabase auth |
| `companies` | Organizations you're selling to |
| `contacts` | People at those companies |
| `deals` | Opportunities with stages and values |
| `interactions` | Calls, emails, meetings, etc. |
| `signals` | Engagement events (email opens, clicks) |
| `tasks` | Follow-ups and action items |
| `agent_logs` | Audit trail for all AI actions |

### Key Relationships

- Companies → Contacts (1:many)
- Companies → Deals (1:many)
- Contacts → Interactions (1:many)
- Contacts → Tasks (1:many)
- Users own companies, contacts, deals

---

## CLI Tool Capabilities

### Tools Available to Claude

| Tool | Description |
|------|-------------|
| `search_companies` | Find companies by name/domain |
| `search_contacts` | Find contacts by name/email |
| `get_company_brief` | Full context dump for a company |
| `get_contact_brief` | Full context dump for a contact |
| `create_company` | Add new company |
| `create_contact` | Add new contact |
| `log_interaction` | Record a call/email/meeting |
| `create_task` | Schedule follow-up |
| `get_call_list` | Prioritized list for a day |
| `update_score` | Manual score adjustment |
| `complete_task` | Mark task as done |
| `list_open_tasks` | Show all pending tasks |

### Example Interactions

```
You: add company Acme Corp, they do B2B SaaS, ~50 employees
AI: Created Acme Corp. Want me to add a contact there?

You: yeah, Mike Smith, he's the VP Sales, mike@acme.com
AI: Added Mike Smith (VP Sales) at Acme Corp.

You: just had a great call with mike, he's interested but budget locked til Q2
AI: Logged call with Mike Smith - positive sentiment, follow-up set for Q2.
    Created task: "Follow up with Mike Smith re: Q2 budget unlock" (due: April 1)

You: who should I call today?
AI: Priority call list for today:
    1. Sarah Chen @ TechStart (score: 85) - requested pricing last week, no response yet
    2. Mike Smith @ Acme Corp (score: 72) - Q2 follow-up due
```

---

## Roadmap

### Phase 1: Foundation ✅
- [x] Supabase schema
- [x] CLI tool with Claude integration
- [x] Basic CRUD operations
- [x] Agent logging

### Phase 2: Agent Pipeline
- [ ] SDR Agent (enrichment)
- [ ] Scoring Agent
- [ ] Task Generation Agent
- [ ] Agent orchestration framework

### Phase 3: Integrations
- [ ] Slack bot
- [ ] Email webhook ingestion
- [ ] Calendar sync

### Phase 4: Intelligence
- [ ] Morning digest
- [ ] Predictive scoring
- [ ] Conversation summaries

---

## Decisions Made

- **Scoring**: Will be handled by dedicated Scoring Agent (future phase), not rules. Manual for now.
- **Multi-user**: Team-ready from day 1 (teams, users, ownership fields).
- **Stack**: Supabase (Postgres) + Node.js + Claude API
