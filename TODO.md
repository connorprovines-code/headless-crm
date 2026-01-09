# Headless CRM - Development TODO

> This file tracks pending work, half-finished agents, tools, and features.
> Updated continuously as work progresses.

---

## 🔴 In Progress

### Migration 006 - Enrichment Infrastructure
- [x] Created migration file
- [ ] Run in Supabase

---

## 🟡 Pending

### Migrations to Run
- [ ] Migration 005 (workflow system)
- [ ] Migration 006 (enrichment + product context)

### Agent Workflows to Define

#### Intake Agent
- **Trigger**: `contact.created`, `company.created`
- **Job**: Gatekeeper - classify, dedupe, route
- **Flow**:
  ```
  1. Extract & normalize incoming data
  2. Duplicate check (exact email match)
     → Match? Log update, emit contact.updated, done
  3. Spam check
     → Spam? Delete, done
  4. Email type check:
     ├─ Personal email → PDL lookup for work email
     │   ├─ Work email found → Emit intake.new_lead → SDR Agent
     │   └─ No work email → Create contact → Emit intake.basic_lead → Scoring Agent
     └─ Company email → Emit intake.new_lead → SDR Agent
  ```
- **Tools needed**: search_contacts, enrich_person_pdl, create_contact, emit_event

#### SDR Agent
- **Trigger**: `intake.new_lead`
- **Job**: Researcher - enrich, synthesize, insight
- **Flow**:
  ```
  1. Hunter.io + Apollo (title, org, work email verification)
  2. Parallel enrichment:
     ├─ Apify: Scrape personal LinkedIn (from PDL linkedin_url)
     └─ Perplexity: Company research
  3. Synthesize data, filter noise
  4. Generate insight (reads product_context table)
  5. Create contact + company → Emit sdr.processed → Scoring Agent
  ```
- **Tools needed**: find_email_hunter, enrich_person_apollo, enrich_company_apollo,
  scrape_linkedin_profile, research_company_perplexity, create_contact, create_company
- **Error handling**: Continue on individual API failure, flag partial enrichment

#### Scoring Agent
- **Trigger**: `sdr.processed`, `intake.basic_lead`, `interaction.logged`, scheduled
- **Job**: Evaluator - calculate/recalculate scores
- **Flow**: TBD
- **Tools needed**: TBD

#### Notification Agent
- **Trigger**: `score.changed`, threshold crossings
- **Job**: Alerter - hot leads, follow-up reminders
- **Flow**: TBD
- **Tools needed**: TBD

### Infrastructure
- [ ] Build workflow executor (processes events → runs workflows)
- [ ] Implement API tool functions (PDL, Hunter, Apollo, Apify, Perplexity)
- [ ] Add tool functions to dashboard

---

## 🟢 Completed

### Migrations Created
- [x] 001 - Initial schema (teams, users, contacts, companies, deals, interactions, signals, tasks)
- [x] 002 - Custom fields + Agent configuration + Events system
- [x] 003 - Scoring rules
- [x] 004 - Tool library system
- [x] 005 - Workflow system + event triggers
- [x] 006 - Enrichment infrastructure + product context

### Dashboard
- [x] Tool library UI with markdown rendering
- [x] Retry logic for failed operations
- [x] 406 error fix for queries

### Architecture
- [x] Event-driven trigger system
- [x] 4-agent pipeline design (Intake → SDR → Scoring → Notification)
- [x] Product context table for agent personalization
- [x] Rate limiting infrastructure
- [x] Enrichment queue for async processing

---

## 📝 Integration Reference

### API Endpoints

| Integration | Endpoint | Auth |
|-------------|----------|------|
| People Data Labs | `POST /v5/person/enrich` | `X-Api-Key` header |
| Hunter.io | `GET /v2/email-finder`, `GET /v2/email-verifier` | `api_key` query param |
| Apollo | `POST /v1/people/match`, `POST /v1/organizations/enrich` | `X-Api-Key` header |
| Apify | `POST /v2/acts/{actorId}/runs` | `token` query param |
| Perplexity | `POST /chat/completions` | `Bearer` token |

### Apify LinkedIn Actor
- Actor ID: `LQQIXN9Othf8f7R5n`
- Input: `{ "username": "linkedin_profile_url" }`

---

## 📊 Agent Pipeline Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     DATA ARRIVES                            │
│              (API / Web Form / Connector)                   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    INTAKE AGENT                             │
│  • Normalize data                                           │
│  • Dupe check (exact email)                                 │
│  • Spam filter                                              │
│  • Personal email? → PDL for work email                     │
└─────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
    [duplicate]          [spam/junk]         [new lead]
    Log update           Delete              │
    emit: contact.updated                    │
                                             ▼
                    ┌────────────────────────┴────────────────┐
                    │                                         │
              [has work email]                       [personal only]
                    │                                         │
                    ▼                                         │
┌─────────────────────────────────────────────────────────────┐
│                     SDR AGENT                               │
│  • Hunter.io (email verification)                           │
│  • Apollo (person + company data)                           │
│  • Apify (LinkedIn scrape via PDL url)                     │
│  • Perplexity (company research)                           │
│  • Synthesize + generate insight                            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    emit: sdr.processed
                            │
                            ├─────────────────────────────────┘
                            │                    (or intake.basic_lead)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   SCORING AGENT                             │
│  • Calculate lead score                                     │
│  • Factor in enrichment data                                │
│  • Compare against ICP (product_context)                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    emit: score.changed (if significant)
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                 NOTIFICATION AGENT                          │
│  • Hot lead alerts                                          │
│  • Follow-up reminders                                      │
│  • Slack/email notifications                                │
└─────────────────────────────────────────────────────────────┘
```

---

*Last updated: 2026-01-09*
