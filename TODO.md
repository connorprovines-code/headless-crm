# Headless CRM - Development TODO

> This file tracks pending work, half-finished agents, tools, and features.
> Updated continuously as work progresses.

---

## 🔴 In Progress

### Agent Definitions
- [ ] **Intake Agent** - Define workflow behavior
  - Trigger: `contact.created`, `company.created`
  - Job: Classify as new/update/duplicate/junk
  - Pending: Define "significant update" rules, duplicate detection strictness, junk filters

- [ ] **SDR Agent** - Define workflow behavior
  - Trigger: `intake.new_lead` event
  - Job: Research, enrich, link to company, initial data gathering

- [ ] **Scoring Agent** - Define workflow behavior
  - Trigger: `sdr.processed`, `interaction.logged`, scheduled runs
  - Job: Calculate/recalculate lead scores

- [ ] **Notification Agent** - Define workflow behavior
  - Trigger: `score.changed`, threshold crossings
  - Job: Alert on hot leads, follow-up reminders

---

## 🟡 Pending

### Migrations
- [ ] Run migration 005 (workflow system) in Supabase

### Infrastructure
- [ ] Build workflow executor (processes events → runs workflows)
- [ ] Add `intake.new_lead` event type to trigger SDR
- [ ] Add `sdr.processed` event type to trigger Scoring
- [ ] Add `score.changed` event type to trigger Notifications

### Tools
- [ ] Define tool permissions per agent
- [ ] Create enrichment tools (company lookup, LinkedIn, etc.)

---

## 🟢 Completed

### Migrations
- [x] Migration 001 - Initial schema (teams, users, contacts, companies, deals, interactions, signals, tasks)
- [x] Migration 002 - Custom fields + Agent configuration
- [x] Migration 003 - Scoring rules (assumed)
- [x] Migration 004 - Tool library system
- [x] Migration 005 - Workflow system + event triggers (created, not yet run)

### Dashboard
- [x] Tool library UI with markdown rendering
- [x] Retry logic for failed operations
- [x] 406 error fix for queries

### Architecture
- [x] Event-driven trigger system
- [x] 4-agent pipeline design (Intake → SDR → Scoring → Notification)

---

## 📝 Notes

### Agent Pipeline Flow
```
Contact/Company Created
        ↓
   [Intake Agent]
   Classifies: new/update/dupe/junk
        ↓ (if new)
   emits: intake.new_lead
        ↓
   [SDR Agent]
   Researches, enriches, links company
        ↓
   emits: sdr.processed
        ↓
   [Scoring Agent]
   Calculates initial score
        ↓ (if hot)
   emits: score.changed
        ↓
   [Notification Agent]
   Alerts team of hot lead
```

---

*Last updated: 2026-01-09*
