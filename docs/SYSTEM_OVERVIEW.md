# System Overview for Orchestrator

> **Last Updated**: 2026-01-13
> **Update this file** when major features ship to any agent or workflow.

This document provides the Orchestrator with visibility into the full system architecture, agent capabilities, and integration points.

---

## Active Event Pipeline

```
Contact INSERT
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  DB Trigger: emit_contact_created_event()                   │
│  → Inserts event: contact.created (10s delay)               │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  DB Trigger: trigger_process_event()                        │
│  → Calls Edge Function via pg_net.http_post()               │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Edge Function: process-event (v6)                          │
│  → Finds matching workflow by trigger_event                 │
│  → Executes workflow steps                                  │
│  → Emits follow-up events                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Active Agents & Workflows

### 1. Intake Agent
- **Trigger**: `contact.created`
- **Purpose**: First responder for new contacts
- **Capabilities**:
  - Normalize contact data (trim, lowercase email)
  - Detect duplicates (exact email match)
  - Classify email type (personal vs company domain)
  - PDL lookup to discover work email from personal email
  - Spam detection (requires ANTHROPIC_API_KEY)
  - Route to appropriate downstream workflow

**Outputs**:
| Condition | Event Emitted | Downstream |
|-----------|---------------|------------|
| Company email | `intake.new_lead` | SDR Agent (Full) |
| Personal email + PDL finds work_email | `intake.new_lead` | SDR Agent (Full) |
| Personal email + PDL fails | `intake.basic_lead` | SDR Agent (Basic) |
| Duplicate detected | `intake.duplicate` | None (stops) |
| Spam detected | `intake.spam` | Contact deleted |

---

### 2. SDR Agent (Full Enrichment)
- **Trigger**: `intake.new_lead`
- **Purpose**: Enrich contacts with company email domains
- **Capabilities**:
  - Extract domain from email
  - Verify email via Hunter
  - Enrich person via PDL (title, company, LinkedIn)
  - Find professional email via Hunter Domain Search
  - Scrape LinkedIn profile via Apify
  - Research company via Perplexity
  - Create/update company record
  - Link contact to company

**Enrichment APIs Used**:
- PeopleDataLabs (PDL) - Person enrichment
- Hunter.io - Email verification & domain search
- Apify - LinkedIn profile scraping
- Perplexity - Company research

**Outputs**: `sdr.processed`, `company.created`, `interaction.logged`

---

### 3. SDR Agent (Basic)
- **Trigger**: `intake.basic_lead`
- **Purpose**: Handle personal email leads without wasting enrichment credits
- **Capabilities**:
  - Load contact
  - Mark as basic tier (no enrichment)
  - Emit processed event

**Note**: No paid API calls - preserves enrichment budget for leads with discoverable work emails.

**Outputs**: `sdr.processed`

---

### 4. Scoring Agent (Disabled)
- **Trigger**: `sdr.processed`
- **Purpose**: Calculate lead scores based on ICP fit
- **Status**: Workflow exists but not yet active

---

### 5. Notification Agent (Disabled)
- **Trigger**: `score.changed`
- **Purpose**: Alert on high-value score changes
- **Status**: Workflow exists but not yet active

---

## Event Types Reference

| Event | Source | Triggers |
|-------|--------|----------|
| `contact.created` | DB trigger on contacts INSERT | Intake Agent |
| `intake.new_lead` | Intake Agent | SDR Agent (Full) |
| `intake.basic_lead` | Intake Agent | SDR Agent (Basic) |
| `intake.duplicate` | Intake Agent | None |
| `intake.spam` | Intake Agent | None |
| `sdr.processed` | SDR Agent | Scoring Agent (when enabled) |
| `company.created` | DB trigger on companies INSERT | None |
| `interaction.logged` | SDR Agent | None |
| `score.changed` | Scoring Agent | Notification Agent |

---

## Integration Credentials (in `integrations` table)

| Name | Purpose | Status |
|------|---------|--------|
| `peopledatalabs` | Person/company enrichment | Enabled |
| `hunter` | Email verification & finder | Enabled |
| `apify` | LinkedIn scraping | Enabled |
| `perplexity` | Company research | Enabled |
| `generect` | Email finder (backup) | Enabled |
| `apollo` | Person/company enrichment | Disabled |
| `anthropic` | AI scoring & insights | Enabled |

---

## Database Tables (Key)

| Table | Purpose |
|-------|---------|
| `contacts` | Lead/contact records |
| `companies` | Company/account records |
| `events` | Event queue (processed by Edge Function) |
| `workflow_templates` | Agent workflow definitions |
| `workflow_steps` | Individual steps within workflows |
| `workflow_runs` | Execution history |
| `workflow_run_logs` | Step-by-step execution logs |
| `agent_configs` | Agent metadata & capabilities |
| `integrations` | API credentials |
| `team_config` | ICP definition, scoring rules |

---

## Querying System State

### Check pending events
```sql
SELECT event_type, COUNT(*) FROM events WHERE processed = false GROUP BY event_type;
```

### Check recent workflow runs
```sql
SELECT wt.name, wr.status, wr.started_at, wr.completed_at
FROM workflow_runs wr
JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
ORDER BY wr.started_at DESC LIMIT 10;
```

### Check agent capabilities
```sql
SELECT name, description, capabilities FROM agent_configs WHERE is_enabled = true;
```

### Check enrichment API status
```sql
SELECT name, is_enabled FROM integrations;
```

---

## Architecture Notes

1. **Serverless**: Everything runs via Supabase Edge Functions - no daemon required
2. **Event-Driven**: Agents communicate via events table, not direct calls
3. **Fault Tolerant**: Each enrichment step has `on_error: continue` - one failure doesn't block others
4. **Cost Aware**: Personal emails without discoverable work_email skip paid enrichment
5. **Portable**: Works for any user with their own Supabase instance

---

## Future Additions (Planned)

- [ ] Orchestrator socket for dynamic Intake Agent configuration
- [ ] Scoring Agent activation
- [ ] Notification Agent activation (Slack/email)
- [ ] Outreach sequence management
- [ ] Daily digest reports

---

## Changelog

### 2026-01-13
- Deployed Edge Function v6 with:
  - LinkedIn scrape now uses PDL-discovered URL (not contact.linkedin_url)
  - Added "Load ICP" step to SDR Agent (step 12)
  - AI scoring integrated into "Generate Insight" step (JSON output with score, icp_fit, etc.)
  - Anthropic API key loaded from `integrations` table (not env var)
- SDR Agent now has 15 steps including ICP-based scoring
- Added `anthropic` integration for AI scoring
- All enrichment APIs working: PDL, Hunter, Apify (LinkedIn posts), Perplexity

### 2026-01-12
- Deployed Edge Function v4 with improved template resolution
- Added SDR Agent (Basic) for `intake.basic_lead` events
- Fixed Intake Agent routing for personal vs company emails
- Added Intake Agent to agent_configs table
