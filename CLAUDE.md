# Claude Code Context - Headless CRM

This file provides context for Claude Code CLI to work effectively with this repository.

## Project Overview

Headless CRM is an AI-orchestrated CRM where humans interact via natural language (CLI, Slack) rather than directly with the database. The core principle is that the AI layer handles all data management, scoring, and task generation.

## Current Phase: 2 (Agent Pipeline)

Active work:
- 3-Agent pipeline: Intake → SDR → Contact
- Workflow executor functional
- Enrichment APIs: Generect (email), PDL, Apify, Perplexity working; Apollo disabled
- **Runtime configuration**: ICP and scoring rules are now stored in `team_config` table
- **Dynamic intake sources**: `intake_sources` table for webhook/API configurations

## Repository Structure

```
/headless-crm
├── CLAUDE.md              # This file - context for Claude
├── README.md              # User-facing documentation
├── .env.example           # Environment template
├── .gitignore
├── /supabase
│   └── /migrations
│       ├── 001_initial_schema.sql      # Core tables
│       ├── 002_workflow_schema.sql     # Workflow engine tables
│       ├── 003-007_*.sql               # Various additions
│       └── 008_revised_agent_workflows.sql  # Current 3-agent pipeline
├── /cli
│   ├── package.json       # Node dependencies
│   ├── index.js           # Entry point, REPL loop (Orchestrator) + Event Processor
│   ├── event-processor.js # Native Realtime event processor (auto-starts with CLI)
│   ├── event-monitor.js   # LEGACY: Polling-based monitor (deprecated)
│   ├── supabase.js        # Supabase client setup
│   ├── tools.js           # Shared tool library (CRUD, search, helpers)
│   ├── prompts.js         # System prompts for CLI agent
│   ├── enrichment-apis.js # PDL, Hunter, Apollo, Apify, Perplexity
│   ├── workflow-executor.js # Generic executor that runs any agent
│   ├── test-workflow.js   # Manual workflow testing
│   └── /agents            # Individual agent definitions
│       ├── index.js       # Agent registry + sync to database
│       ├── intake-agent.js    # Intake Agent v2 definition
│       ├── sdr-agent.js       # SDR Agent v2 definition
│       └── contact-agent.js   # Contact Agent definitions
└── /docs
    └── ARCHITECTURE.md    # Full architecture and roadmap
```

## Agent Pipeline

### Active Agents
| Agent | Trigger | Status |
|-------|---------|--------|
| **Intake Agent** | `contact.created` | Active |
| **SDR Agent** | `intake.new_lead` | Active |
| Scoring Agent | `sdr.processed` | Disabled |
| Notification Agent | `score.changed` | Disabled |

### Flow: Contact Created → Intake → SDR
```
1. Contact inserted (via CLI, API, webhook, form)
2. Database trigger emits `contact.created` event (10s delay)
3. Event Processor (Realtime) picks up event
4. Intake Agent runs:
   - Normalize data
   - Check duplicates
   - Spam detection
   - Classify email (personal vs company)
   - PDL lookup if personal email
   - Emits `intake.new_lead`
5. SDR Agent runs:
   - Extract domain
   - Verify email (Hunter)
   - Enrich person/company (Apollo)
   - Scrape LinkedIn
   - Research company (Perplexity)
   - Generate insight
   - Emits `sdr.processed`
```

### Intake Agent (9 steps)
- Trigger: `contact.created`
- Job: Gatekeeper - normalizes data, checks duplicates, detects spam, routes based on email type
- If personal email → PDL lookup for company info
- Emits: `intake.new_lead` or `intake.basic_lead`

### SDR Agent (14 steps)
- Trigger: `intake.new_lead`
- Job: Researcher - enriches via Hunter/Apollo/Apify/Perplexity, generates insights
- Emits: `sdr.processed`

## Key Files

### Schema: `supabase/migrations/008_revised_agent_workflows.sql`
- Latest workflow definitions
- Contact table additions: work_email, personal_email, enrichment_tier, enrichment_data, score_breakdown, flags, sales_notes

### Runtime Config: `supabase/migrations/009_runtime_config.sql`
- `intake_sources` - Dynamic intake configuration (webhooks, APIs, forms)
- `team_config` - ICP, scoring rules, enrichment settings
- `config_audit_log` - Tracks all config changes
- Default ICP and scoring rules inserted for all teams

### Enrichment APIs: `cli/enrichment-apis.js`
- `enrich_person_pdl` - Get company info, LinkedIn, title from personal email
- `find_email_generect` - **Primary email finder** ($0.03/success, validated)
- `find_email_hunter` - Find email by domain + name (backup)
- `verify_email_hunter` - Verify email deliverability
- `scrape_linkedin_profile` - LinkedIn data via Apify (limit=10 for cost)
- `research_company_perplexity` - Company research (depth: light/deep)
- Apollo functions disabled (requires paid subscription)

### Workflow Executor: `cli/workflow-executor.js`
- `emitEvent()` - Emit event to trigger workflows
- `executeWorkflow()` - Run workflow steps
- `processEvent()` - Find and run matching workflows
- Logs all executions to `workflow_runs` and `workflow_run_logs`

### Tools: `cli/tools.js`
- Contact/Company/Deal CRUD operations
- Search functions
- All mutations log to `agent_logs`
- **Runtime config tools**:
  - `get_icp` / `update_icp` - View/modify Ideal Customer Profile
  - `get_scoring_rules_config` / `update_scoring_rules` - View/modify scoring thresholds
  - `list_intake_sources` / `create_intake_source` / `update_intake_source` - Manage intake sources
  - `get_config` / `set_config` - Generic config access

## Environment Variables

Required:
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_KEY` - Service role key (full access)
- `ANTHROPIC_API_KEY` - Claude API key

Optional:
- `DEFAULT_TEAM_ID` - Default team UUID (null for teamless mode)
- `DEFAULT_USER_ID` - Default user UUID

## Development Workflow

1. Make changes to relevant files
2. Start CLI: `cd cli && npm start` (event processor starts automatically)
3. Test workflows: `node test-workflow.js`
4. For migrations: Use Supabase MCP or SQL editor

## Running the System

**Single Terminal - Full System:**
```bash
cd cli && npm start
```
This starts:
- The CLI orchestrator (natural language interface)
- The native event processor (Supabase Realtime subscription)

The event processor automatically:
- Connects to Supabase Realtime via WebSocket
- Listens for new events (INSERT on `events` table)
- Processes events through the workflow executor
- Handles backlog of unprocessed events on startup
- Auto-reconnects on connection drops

**Built-in Commands:**
- `status` or `/status` - Show event processor status
- `exit` or `quit` - Graceful shutdown

## Conventions

- Use ES modules (`import`/`export`)
- Async/await for all database operations
- Log all mutations via `logAgentAction()`
- Keep tool implementations in `tools.js`, prompts in `prompts.js`
- Add CHECK constraints for enum-like fields in schema
- Indexes on all foreign keys and common query patterns

## Cost Awareness

Enrichment costs per lead (approximate):
- **Deep enrichment (~20¢)**: PDL + Hunter verify + Perplexity deep + LinkedIn (10 posts)
- **Light enrichment (~3¢)**: Hunter verify + Perplexity light
- **No enrichment (~1¢)**: Just AI scoring

Design decisions should consider cost/value tradeoffs.

## Documentation Rules

**IMPORTANT**: Before ending a session or when context is getting full:
1. Update this CLAUDE.md with any significant changes
2. Update docs/ARCHITECTURE.md if architecture changed
3. Add comments to complex code sections
4. Ensure migration files have summary comments at the end

This ensures continuity across sessions when context resets.

## Database Triggers

Migration 010 added:
- `contact_created_trigger` - Automatically emits `contact.created` event on any contact INSERT
- Event includes 10s delay (`delay_until` in payload) to let data settle
- SDR Agent only triggers on `contact.created` (not `company.created` to avoid double-processing)

## Next Steps (TODO)

1. ~~Run migration 009 to create runtime config tables~~ ✓
2. ~~Create event monitor for SDR pipeline~~ ✓
3. Test ICP update via CLI ("Our ICP is now Series A SaaS companies")
4. Test intake source creation ("Add a webhook for Typeform leads")
5. Build Slack integration for Contact Agent notifications
6. Add more robust domain derivation (Perplexity fallback if AI guess fails)

## Adding a New Agent

1. Create `cli/agents/new-agent.js` with the agent definition
2. Export from `cli/agents/index.js`
3. Run `syncAgents()` to push to database (or add to migration)
4. Agent will auto-run when its trigger_event fires

## Key Architecture Decisions

- **Agents as JS files**: Each agent is defined in its own file for easy editing
- **tools.js as shared library**: All agents import tools from here
- **workflow-executor.js**: Generic engine that can run any agent definition
- **Tiered enrichment**: Cost-aware - only deep enrich high-value leads
- **Runtime configuration**: ICP and scoring rules stored in database, not hardcoded
- **Self-modifying via CLI**: User can say "update my ICP" and the system updates itself
- **Native event processing**: Supabase Realtime (WebSocket) instead of polling - instant, scalable

## Event Processor Architecture

The `event-processor.js` module provides native, always-on event handling:

```
CLI boots → startEventProcessor()
         → Opens Realtime subscription to `events` table
         → Processes any backlogged events
         → Each new INSERT triggers handleNewEvent()
         → Routes to workflow executor
         → Marks event as processed
```

**Key features:**
- **No separate daemon**: Runs inside the main CLI process
- **Instant processing**: WebSocket push, not polling
- **Custom handlers**: Agents can register via `registerHandler(eventType, fn)`
- **Backlog handling**: Processes unprocessed events on startup
- **Auto-reconnect**: Exponential backoff on connection drops

**API:**
```javascript
import { registerHandler, getStatus } from './event-processor.js';

// Register custom handler for an event type
registerHandler('contact.created', async (event) => {
  // Custom logic here
}, { name: 'my-handler', priority: 10 });

// Check status
const status = getStatus();
// { connected: true, eventsProcessed: 42, registeredEventTypes: [...] }
```

## Runtime Configuration

The CRM is self-modifying. The CLI can update these configs via natural language:

| Config Key | What it controls | Example CLI command |
|------------|------------------|---------------------|
| `icp` | Ideal Customer Profile (titles, company size, industries) | "Our ICP is Series A SaaS, 50-200 employees" |
| `scoring_rules` | Score thresholds, point values | "Lower hot lead threshold to 7" |
| `enrichment_settings` | Which APIs to use, cost limits | "Don't enrich leads under score 4" |

### Intake Sources

New lead sources can be added at runtime:
```
"Add a webhook intake for Typeform"
→ Creates intake_sources record
→ Returns webhook URL and secret
→ Leads from that source auto-enrich
```
