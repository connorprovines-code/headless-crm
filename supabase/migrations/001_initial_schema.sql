-- Headless CRM Initial Schema
-- Run this in Supabase SQL Editor or via migrations

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TEAMS & USERS
-- ============================================================================

CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
    id UUID PRIMARY KEY,  -- matches Supabase auth.users.id
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    role TEXT DEFAULT 'rep' CHECK (role IN ('admin', 'manager', 'rep')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- CORE CRM ENTITIES
-- ============================================================================

CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    domain TEXT,
    industry TEXT,
    employee_count TEXT,  -- "1-10", "11-50", "51-200", "201-500", "500+"
    notes TEXT,
    score INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique domain per team (allows same domain across different teams)
CREATE UNIQUE INDEX companies_domain_team_idx ON companies(domain, team_id) WHERE domain IS NOT NULL;

CREATE TABLE contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    first_name TEXT NOT NULL,
    last_name TEXT,
    email TEXT,
    phone TEXT,
    title TEXT,
    role_type TEXT CHECK (role_type IN ('decision_maker', 'champion', 'influencer', 'blocker', 'user', 'other')),
    linkedin_url TEXT,
    notes TEXT,
    score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'churned', 'do_not_contact')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE deals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,  -- primary contact
    name TEXT NOT NULL,
    stage TEXT DEFAULT 'prospecting' CHECK (stage IN ('prospecting', 'discovery', 'proposal', 'negotiation', 'closed_won', 'closed_lost')),
    value NUMERIC,
    close_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INTERACTIONS & SIGNALS
-- ============================================================================

CREATE TABLE interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- who performed the interaction
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('call', 'email_sent', 'email_received', 'meeting', 'linkedin', 'slack', 'note')),
    channel TEXT CHECK (channel IN ('phone', 'email', 'linkedin', 'slack', 'in_person', 'video')),
    direction TEXT CHECK (direction IN ('inbound', 'outbound')),
    subject TEXT,
    content TEXT,
    sentiment TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative')),
    outcome TEXT,  -- "connected", "voicemail", "no_answer", "replied", "scheduled", etc.
    follow_up_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    type TEXT NOT NULL,  -- "email_opened", "link_clicked", "meeting_booked", "went_dark", "news_mention", etc.
    source TEXT,  -- where signal came from
    weight INTEGER DEFAULT 0,  -- scoring impact
    data JSONB,  -- flexible payload
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TASKS
-- ============================================================================

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('call', 'email', 'follow_up', 'research', 'meeting', 'other')),
    priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),  -- 1 = highest priority
    reason TEXT,  -- AI explains why this task exists
    due_date DATE,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- AGENT AUDIT LOG
-- ============================================================================

CREATE TABLE agent_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,  -- which agent/function acted
    action TEXT NOT NULL,  -- "create_contact", "update_score", "generate_task", etc.
    entity_type TEXT,  -- "contact", "company", "deal", "task"
    entity_id UUID,
    input JSONB,  -- what triggered the action
    output JSONB,  -- what was done
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Lookup indexes
CREATE INDEX contacts_company_idx ON contacts(company_id);
CREATE INDEX contacts_team_idx ON contacts(team_id);
CREATE INDEX contacts_owner_idx ON contacts(owner_id);
CREATE INDEX contacts_status_idx ON contacts(status);

CREATE INDEX companies_team_idx ON companies(team_id);
CREATE INDEX companies_owner_idx ON companies(owner_id);

CREATE INDEX deals_team_idx ON deals(team_id);
CREATE INDEX deals_company_idx ON deals(company_id);
CREATE INDEX deals_stage_idx ON deals(stage);

CREATE INDEX interactions_contact_idx ON interactions(contact_id);
CREATE INDEX interactions_company_idx ON interactions(company_id);
CREATE INDEX interactions_created_idx ON interactions(created_at DESC);

CREATE INDEX tasks_assigned_idx ON tasks(assigned_to);
CREATE INDEX tasks_due_date_idx ON tasks(due_date);
CREATE INDEX tasks_priority_idx ON tasks(priority);
CREATE INDEX tasks_uncompleted_idx ON tasks(due_date) WHERE completed_at IS NULL;

CREATE INDEX signals_contact_idx ON signals(contact_id);
CREATE INDEX signals_company_idx ON signals(company_id);
CREATE INDEX signals_type_idx ON signals(type);

CREATE INDEX agent_logs_entity_idx ON agent_logs(entity_type, entity_id);
CREATE INDEX agent_logs_created_idx ON agent_logs(created_at DESC);

-- ============================================================================
-- TRIGGERS: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER contacts_updated_at
    BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER deals_updated_at
    BEFORE UPDATE ON deals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) - Optional, enable per table as needed
-- ============================================================================

-- Example: Enable RLS on companies (uncomment to use)
-- ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Users can view companies in their team" ON companies
--     FOR SELECT USING (team_id IN (SELECT team_id FROM users WHERE id = auth.uid()));
