# Claude Code Context - Headless CRM

This file provides context for Claude Code CLI to work effectively with this repository.

## Project Overview

Headless CRM is an AI-orchestrated CRM where humans interact via natural language (CLI, Slack) rather than directly with the database. The core principle is that the AI layer handles all data management, scoring, and task generation.

## Repository Structure

```
/headless-crm
├── CLAUDE.md              # This file - context for Claude
├── README.md              # User-facing documentation
├── .env.example           # Environment template
├── .gitignore
├── /supabase
│   └── /migrations
│       └── 001_initial_schema.sql   # Database schema
├── /cli
│   ├── package.json       # Node dependencies
│   ├── index.js           # Entry point, REPL loop
│   ├── supabase.js        # Supabase client setup
│   ├── tools.js           # Claude tool definitions + implementations
│   └── prompts.js         # System prompts for CLI agent
└── /docs
    └── ARCHITECTURE.md    # Full architecture and roadmap
```

## Key Files

### Schema: `supabase/migrations/001_initial_schema.sql`
- Core tables: teams, users, companies, contacts, deals, interactions, signals, tasks, agent_logs
- All tables have team_id for multi-tenancy
- agent_logs captures all AI actions for audit trail

### Tools: `cli/tools.js`
- `toolDefinitions` - Anthropic tool schema format
- Tool implementations for all CRUD operations
- `executeTool(name, input)` - dispatcher for tool calls
- All mutations log to `agent_logs` via `logAgentAction()`

### Prompts: `cli/prompts.js`
- `SYSTEM_PROMPT` - defines CLI agent behavior
- `GREETING` - welcome message with examples

## Tech Stack

- **Database**: Supabase (PostgreSQL)
- **CLI**: Node.js with ES modules
- **AI**: Claude API via `@anthropic-ai/sdk`
- **Auth**: Supabase service key (full access for now)

## Common Tasks

### Adding a new tool
1. Add tool definition to `toolDefinitions` array in `cli/tools.js`
2. Implement the function with same name
3. Add to `toolFunctions` object at bottom
4. Update `SYSTEM_PROMPT` in `cli/prompts.js` if behavior guidance needed

### Modifying the schema
1. Create new migration file: `supabase/migrations/002_*.sql`
2. Update `docs/ARCHITECTURE.md` schema section
3. If new table, may need new tool functions in `cli/tools.js`

### Adding a new agent (future)
1. Create new file in `/agents` directory (to be created)
2. Agent should:
   - Have clear trigger conditions (event, interval)
   - Use tools from `cli/tools.js` or define own
   - Log all actions to `agent_logs`
   - Chain to next agent if applicable

## Environment Variables

Required:
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_KEY` - Service role key (full access)
- `ANTHROPIC_API_KEY` - Claude API key

Optional:
- `DEFAULT_TEAM_ID` - Default team UUID for single-user mode
- `DEFAULT_USER_ID` - Default user UUID for single-user mode

## Development Workflow

1. Make changes to relevant files
2. Test locally: `cd cli && npm start`
3. Common test commands in CLI:
   - "add company Test Corp"
   - "add contact John at Test Corp"
   - "brief me on Test Corp"
   - "who should I call today?"

## Current Phase: 1 (Foundation)

Active work:
- Core schema complete
- CLI tool functional
- Manual scoring only

Next phases (not started):
- Phase 2: Agent pipeline (SDR, Scoring, Task agents)
- Phase 3: Slack bot, webhooks
- Phase 4: Morning digest, predictive features

## Conventions

- Use ES modules (`import`/`export`)
- Async/await for all database operations
- Log all mutations via `logAgentAction()`
- Keep tool implementations in `tools.js`, prompts in `prompts.js`
- Add CHECK constraints for enum-like fields in schema
- Indexes on all foreign keys and common query patterns
