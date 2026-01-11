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
│   ├── index.js           # Entry point, REPL loop
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

## Agent Pipeline (Migration 008)

### 1. Intake Agent v2
- Trigger: `contact.created`
- Job: Extract → Spam Check → Dedupe → Route
- Routes NEW contacts to SDR, EXISTING to Contact Agent

### 2. SDR Agent v4 (merged with Scoring)
- Trigger: `intake.new_contact`
- Job: Get company info → Find work email (Generect) → **Load ICP config** → Score → Tiered enrichment → Deep analysis (7+) → Route
- Work email flow:
  1. Classify email (personal vs business)
  2. If personal → PDL for company info (name, LinkedIn, title)
  3. AI derives domain from company name
  4. Generect finds validated work email ($0.03/success)
- **Scoring uses dynamic ICP from `team_config` table**
- Enrichment tiers (configurable via `scoring_rules` config):
  - **Deep (7-10)**: Perplexity deep + LinkedIn + full analysis (~8-10¢)
  - **Light (5-6)**: Perplexity light (~5¢)
  - **None (0-4)**: Just scoring (~4¢)

### 3. Contact Agent
- Trigger: `sdr.complete` or `intake.existing_updated`
- Job: Notify sales (hot leads 8+), queue warm leads (6-7), create follow-up tasks

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
2. Test locally: `cd cli && npm start`
3. Test workflows: `node test-workflow.js`
4. For migrations: Copy SQL to Supabase SQL editor and run

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

## Next Steps (TODO)

1. Run migration 009 to create runtime config tables
2. Test ICP update via CLI ("Our ICP is now Series A SaaS companies")
3. Test intake source creation ("Add a webhook for Typeform leads")
4. Build Slack integration for Contact Agent notifications
5. Add more robust domain derivation (Perplexity fallback if AI guess fails)

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
