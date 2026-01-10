# Claude Code Context - Headless CRM

This file provides context for Claude Code CLI to work effectively with this repository.

## Project Overview

Headless CRM is an AI-orchestrated CRM where humans interact via natural language (CLI, Slack) rather than directly with the database. The core principle is that the AI layer handles all data management, scoring, and task generation.

## Current Phase: 2 (Agent Pipeline)

Active work:
- 3-Agent pipeline: Intake → SDR → Contact
- Workflow executor functional
- Enrichment APIs: Hunter, Apify, Perplexity working; PDL ready; Apollo disabled

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

### 2. SDR Agent v2 (merged with Scoring)
- Trigger: `intake.new_contact`
- Job: Ensure work email → Initial score (0-10) → Tiered enrichment → Deep analysis (7+) → Re-score → Route
- Enrichment tiers:
  - **Deep (7-10)**: PDL + Hunter + Perplexity deep + LinkedIn + Apollo
  - **Light (5-6)**: Hunter + Perplexity light
  - **None (0-4)**: Skip enrichment (save money)

### 3. Contact Agent
- Trigger: `sdr.complete` or `intake.existing_updated`
- Job: Notify sales (hot leads 8+), queue warm leads (6-7), create follow-up tasks

## Key Files

### Schema: `supabase/migrations/008_revised_agent_workflows.sql`
- Latest workflow definitions
- Contact table additions: work_email, personal_email, enrichment_tier, enrichment_data, score_breakdown, flags, sales_notes

### Enrichment APIs: `cli/enrichment-apis.js`
- `enrich_person_pdl` - Find work email from personal email
- `find_email_hunter` - Find email by domain + name
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

1. Test full pipeline with a contact
2. Add PDL API key and test work email lookup
3. Build Slack integration for Contact Agent notifications
4. Add merge_contact_data and delete_contact tools for Intake Agent

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
