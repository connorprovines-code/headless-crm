-- Migration 004: Tool Library System
-- Provides guardrails for what agents can do - they can only use pre-defined tools

-- ============================================================================
-- TOOL LIBRARY TABLE
-- ============================================================================
-- These are the "approved" tools that agents can use.
-- Adding new tools requires a migration (this process), not the Orchestrator.

CREATE TABLE IF NOT EXISTS tool_library (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Tool identity
    name VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,

    -- Categorization
    category VARCHAR(50) NOT NULL DEFAULT 'crm',
    -- Categories: crm, integration, communication, enrichment, internal

    -- Tool definition (matches Claude tool format)
    input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Execution info
    handler_type VARCHAR(50) NOT NULL DEFAULT 'builtin',
    -- Types: builtin (JS function), webhook, supabase_function, external_api
    handler_config JSONB DEFAULT '{}'::jsonb,
    -- For webhook: { url, method, headers }
    -- For external_api: { base_url, auth_type, auth_config }
    -- For builtin: {} (handled in code)

    -- Security & Access
    requires_auth BOOLEAN DEFAULT false,
    auth_config_key VARCHAR(100), -- Key in integrations table for credentials
    risk_level VARCHAR(20) DEFAULT 'low', -- low, medium, high, critical
    -- low: read-only, no external calls
    -- medium: writes to DB
    -- high: external API calls
    -- critical: sends emails, modifies billing, etc.

    -- Status
    is_enabled BOOLEAN DEFAULT true,
    is_system BOOLEAN DEFAULT true, -- System tools can't be deleted

    -- Metadata
    version INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INTEGRATIONS TABLE
-- ============================================================================
-- Stores API credentials and connection settings for external tools
-- Orchestrator CAN edit this (configure connections) but can't add new tool types

CREATE TABLE IF NOT EXISTS integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

    -- Integration identity
    name VARCHAR(100) NOT NULL, -- e.g., 'sendgrid', 'slack', 'apollo'
    display_name VARCHAR(200),

    -- Connection status
    is_connected BOOLEAN DEFAULT false,
    is_enabled BOOLEAN DEFAULT true,
    last_tested_at TIMESTAMPTZ,
    last_error TEXT,

    -- Credentials (encrypted in production)
    credentials JSONB DEFAULT '{}'::jsonb,
    -- Structure depends on integration:
    -- SendGrid: { api_key }
    -- Slack: { webhook_url, bot_token }
    -- Apollo: { api_key }

    -- Settings
    settings JSONB DEFAULT '{}'::jsonb,
    -- Integration-specific settings

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    configured_by UUID, -- Who set this up (Orchestrator logs this)

    UNIQUE(team_id, name)
);

-- ============================================================================
-- AGENT TOOL PERMISSIONS
-- ============================================================================
-- Junction table: which agents can use which tools
-- Orchestrator CAN edit this (grant/revoke tool access)

CREATE TABLE IF NOT EXISTS agent_tool_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_config_id UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
    tool_id UUID NOT NULL REFERENCES tool_library(id) ON DELETE CASCADE,

    -- Permission level
    permission_level VARCHAR(20) DEFAULT 'full', -- full, read_only, restricted

    -- Restrictions (optional)
    restrictions JSONB DEFAULT '{}'::jsonb,
    -- e.g., { max_calls_per_run: 10, allowed_params: [...] }

    -- Audit
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    granted_by VARCHAR(100), -- 'system', 'orchestrator', 'admin'

    UNIQUE(agent_config_id, tool_id)
);

-- ============================================================================
-- TOOL EXECUTION LOG
-- ============================================================================
-- Detailed log of every tool call for audit/debugging

CREATE TABLE IF NOT EXISTS tool_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Context
    agent_config_id UUID REFERENCES agent_configs(id) ON DELETE SET NULL,
    agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
    tool_id UUID REFERENCES tool_library(id) ON DELETE SET NULL,
    tool_name VARCHAR(100) NOT NULL, -- Denormalized for when tool is deleted

    -- Execution details
    input JSONB,
    output JSONB,
    error_message TEXT,

    -- Performance
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,

    -- Status
    status VARCHAR(20) DEFAULT 'pending', -- pending, running, success, error

    -- For integrations
    integration_id UUID REFERENCES integrations(id) ON DELETE SET NULL,
    external_request_id VARCHAR(200) -- ID from external API if applicable
);

-- ============================================================================
-- SEED: BUILT-IN CRM TOOLS
-- ============================================================================

INSERT INTO tool_library (name, display_name, description, category, input_schema, handler_type, risk_level, is_system) VALUES

-- READ TOOLS (low risk)
('search_companies', 'Search Companies', 'Search for companies by name or domain', 'crm',
 '{"type":"object","properties":{"query":{"type":"string","description":"Search term"},"limit":{"type":"number","description":"Max results (default 10)"}},"required":["query"]}',
 'builtin', 'low', true),

('search_contacts', 'Search Contacts', 'Search for contacts by name, email, or company', 'crm',
 '{"type":"object","properties":{"query":{"type":"string","description":"Search term"},"limit":{"type":"number","description":"Max results (default 10)"}},"required":["query"]}',
 'builtin', 'low', true),

('get_company_brief', 'Get Company Brief', 'Get full context for a company including contacts, deals, interactions', 'crm',
 '{"type":"object","properties":{"company_id":{"type":"string","description":"UUID of company"},"company_name":{"type":"string","description":"Company name (if no ID)"}}}',
 'builtin', 'low', true),

('get_contact_brief', 'Get Contact Brief', 'Get full context for a contact including company, interactions, tasks', 'crm',
 '{"type":"object","properties":{"contact_id":{"type":"string","description":"UUID of contact"},"contact_name":{"type":"string","description":"Contact name (if no ID)"}}}',
 'builtin', 'low', true),

('get_call_list', 'Get Call List', 'Get prioritized call list for today', 'crm',
 '{"type":"object","properties":{"date":{"type":"string","description":"Date (YYYY-MM-DD), defaults to today"},"limit":{"type":"number","description":"Max tasks (default 10)"}}}',
 'builtin', 'low', true),

('list_open_tasks', 'List Open Tasks', 'List all uncompleted tasks', 'crm',
 '{"type":"object","properties":{"limit":{"type":"number","description":"Max tasks (default 20)"}}}',
 'builtin', 'low', true),

-- WRITE TOOLS (medium risk)
('create_company', 'Create Company', 'Create a new company record', 'crm',
 '{"type":"object","properties":{"name":{"type":"string","description":"Company name"},"domain":{"type":"string","description":"Website domain"},"industry":{"type":"string","description":"Industry"},"employee_count":{"type":"string","description":"Size range"},"notes":{"type":"string","description":"Notes"}},"required":["name"]}',
 'builtin', 'medium', true),

('create_contact', 'Create Contact', 'Create a new contact, optionally linked to company', 'crm',
 '{"type":"object","properties":{"first_name":{"type":"string","description":"First name"},"last_name":{"type":"string","description":"Last name"},"email":{"type":"string","description":"Email"},"phone":{"type":"string","description":"Phone"},"title":{"type":"string","description":"Job title"},"company_name":{"type":"string","description":"Company to link"}},"required":["first_name"]}',
 'builtin', 'medium', true),

('log_interaction', 'Log Interaction', 'Log a call, email, meeting, etc.', 'crm',
 '{"type":"object","properties":{"contact_id":{"type":"string"},"contact_name":{"type":"string"},"type":{"type":"string","description":"call, email, meeting, etc."},"sentiment":{"type":"string","description":"positive, neutral, negative"},"content":{"type":"string","description":"Notes"}},"required":["type"]}',
 'builtin', 'medium', true),

('create_task', 'Create Task', 'Create a follow-up task', 'crm',
 '{"type":"object","properties":{"contact_name":{"type":"string"},"type":{"type":"string","description":"call, email, follow_up, etc."},"priority":{"type":"number","description":"1-10"},"reason":{"type":"string","description":"Why this task"},"due_date":{"type":"string","description":"YYYY-MM-DD"}},"required":["type","reason"]}',
 'builtin', 'medium', true),

('complete_task', 'Complete Task', 'Mark a task as done', 'crm',
 '{"type":"object","properties":{"task_id":{"type":"string","description":"UUID of task"}},"required":["task_id"]}',
 'builtin', 'medium', true),

('update_score', 'Update Score', 'Update contact or company score', 'crm',
 '{"type":"object","properties":{"entity_type":{"type":"string","description":"contact or company"},"entity_name":{"type":"string"},"score":{"type":"number","description":"0-100"},"reason":{"type":"string"}},"required":["entity_type","score"]}',
 'builtin', 'medium', true),

-- AGENT MANAGEMENT TOOLS (Orchestrator only - medium risk)
('list_agents', 'List Agents', 'List all configured agents', 'internal',
 '{"type":"object","properties":{"include_disabled":{"type":"boolean","description":"Include disabled agents"}}}',
 'builtin', 'low', true),

('get_agent_details', 'Get Agent Details', 'Get full config and recent runs for an agent', 'internal',
 '{"type":"object","properties":{"agent_id":{"type":"string"},"agent_name":{"type":"string"}}}',
 'builtin', 'low', true),

('update_agent', 'Update Agent', 'Modify agent configuration', 'internal',
 '{"type":"object","properties":{"agent_name":{"type":"string"},"is_enabled":{"type":"boolean"},"trigger_type":{"type":"string"},"trigger_config":{"type":"object"}}}',
 'builtin', 'medium', true),

('get_recent_agent_activity', 'Get Agent Activity', 'Get recent activity from all agents', 'internal',
 '{"type":"object","properties":{"limit":{"type":"number","description":"Max entries (default 20)"}}}',
 'builtin', 'low', true),

('get_pending_events', 'Get Pending Events', 'Get events waiting for processing', 'internal',
 '{"type":"object","properties":{"limit":{"type":"number","description":"Max events (default 50)"}}}',
 'builtin', 'low', true),

-- INTEGRATION MANAGEMENT (Orchestrator only - high risk)
('list_integrations', 'List Integrations', 'List available integrations and their status', 'internal',
 '{"type":"object","properties":{}}',
 'builtin', 'low', true),

('configure_integration', 'Configure Integration', 'Set up or update integration credentials', 'internal',
 '{"type":"object","properties":{"name":{"type":"string","description":"Integration name (e.g., sendgrid)"},"credentials":{"type":"object","description":"API keys, tokens, etc."},"settings":{"type":"object","description":"Integration-specific settings"}},"required":["name"]}',
 'builtin', 'high', true),

('test_integration', 'Test Integration', 'Test if an integration is working', 'internal',
 '{"type":"object","properties":{"name":{"type":"string","description":"Integration name"}},"required":["name"]}',
 'builtin', 'medium', true),

-- TOOL PERMISSION MANAGEMENT (Orchestrator only)
('grant_tool_access', 'Grant Tool Access', 'Give an agent permission to use a tool', 'internal',
 '{"type":"object","properties":{"agent_name":{"type":"string"},"tool_name":{"type":"string"},"permission_level":{"type":"string","description":"full, read_only, restricted"}},"required":["agent_name","tool_name"]}',
 'builtin', 'medium', true),

('revoke_tool_access', 'Revoke Tool Access', 'Remove an agent permission to use a tool', 'internal',
 '{"type":"object","properties":{"agent_name":{"type":"string"},"tool_name":{"type":"string"}},"required":["agent_name","tool_name"]}',
 'builtin', 'medium', true),

('list_tool_library', 'List Tool Library', 'List all available tools in the system', 'internal',
 '{"type":"object","properties":{"category":{"type":"string","description":"Filter by category"}}}',
 'builtin', 'low', true)

ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- SEED: INTEGRATION TEMPLATES
-- ============================================================================
-- These define what integrations are POSSIBLE (not configured yet)

CREATE TABLE IF NOT EXISTS integration_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(200) NOT NULL,
    description TEXT,
    category VARCHAR(50) DEFAULT 'communication',
    -- Categories: communication, enrichment, calendar, storage, analytics

    -- What credentials are needed
    required_credentials JSONB NOT NULL,
    -- e.g., [{"key": "api_key", "label": "API Key", "type": "password"}]

    -- What settings are available
    available_settings JSONB DEFAULT '[]'::jsonb,

    -- Documentation
    setup_instructions TEXT,
    docs_url VARCHAR(500),

    -- Status
    is_available BOOLEAN DEFAULT true,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO integration_templates (name, display_name, description, category, required_credentials, setup_instructions) VALUES
('sendgrid', 'SendGrid', 'Send emails via SendGrid API', 'communication',
 '[{"key":"api_key","label":"API Key","type":"password"}]',
 'Get your API key from SendGrid dashboard > Settings > API Keys'),

('resend', 'Resend', 'Send emails via Resend API', 'communication',
 '[{"key":"api_key","label":"API Key","type":"password"}]',
 'Get your API key from resend.com/api-keys'),

('slack', 'Slack', 'Send messages to Slack channels', 'communication',
 '[{"key":"webhook_url","label":"Webhook URL","type":"text"},{"key":"bot_token","label":"Bot Token (optional)","type":"password"}]',
 'Create an incoming webhook at api.slack.com/apps'),

('apollo', 'Apollo.io', 'Enrich contacts with Apollo data', 'enrichment',
 '[{"key":"api_key","label":"API Key","type":"password"}]',
 'Get your API key from Apollo > Settings > API'),

('clearbit', 'Clearbit', 'Enrich companies and contacts', 'enrichment',
 '[{"key":"api_key","label":"API Key","type":"password"}]',
 'Get your API key from clearbit.com/dashboard'),

('google_calendar', 'Google Calendar', 'Create and manage calendar events', 'calendar',
 '[{"key":"client_id","label":"Client ID","type":"text"},{"key":"client_secret","label":"Client Secret","type":"password"},{"key":"refresh_token","label":"Refresh Token","type":"password"}]',
 'Set up OAuth in Google Cloud Console')

ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- PLACEHOLDER TOOLS FOR FUTURE INTEGRATIONS
-- ============================================================================
-- These tools exist but require integration setup to work

INSERT INTO tool_library (name, display_name, description, category, input_schema, handler_type, handler_config, requires_auth, auth_config_key, risk_level, is_enabled, is_system) VALUES

('send_email', 'Send Email', 'Send an email to a contact', 'communication',
 '{"type":"object","properties":{"to":{"type":"string","description":"Email address"},"subject":{"type":"string"},"body":{"type":"string"},"contact_id":{"type":"string","description":"Optional: link to contact"}},"required":["to","subject","body"]}',
 'external_api', '{"integration":"sendgrid"}', true, 'sendgrid', 'critical', false, true),

('send_slack_message', 'Send Slack Message', 'Send a message to a Slack channel', 'communication',
 '{"type":"object","properties":{"channel":{"type":"string","description":"Channel name or ID"},"message":{"type":"string"}},"required":["channel","message"]}',
 'external_api', '{"integration":"slack"}', true, 'slack', 'high', false, true),

('enrich_contact_apollo', 'Enrich Contact (Apollo)', 'Enrich contact data using Apollo.io', 'enrichment',
 '{"type":"object","properties":{"email":{"type":"string","description":"Email to look up"},"contact_id":{"type":"string","description":"Contact to update"}},"required":["email"]}',
 'external_api', '{"integration":"apollo"}', true, 'apollo', 'medium', false, true),

('enrich_company_clearbit', 'Enrich Company (Clearbit)', 'Enrich company data using Clearbit', 'enrichment',
 '{"type":"object","properties":{"domain":{"type":"string","description":"Company domain"},"company_id":{"type":"string","description":"Company to update"}},"required":["domain"]}',
 'external_api', '{"integration":"clearbit"}', true, 'clearbit', 'medium', false, true)

ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- DEFAULT TOOL PERMISSIONS FOR SYSTEM AGENTS
-- ============================================================================

-- Grant Orchestrator access to management tools
DO $$
DECLARE
    orchestrator_id UUID;
    tool_rec RECORD;
BEGIN
    SELECT id INTO orchestrator_id FROM agent_configs WHERE name = 'Orchestrator' LIMIT 1;

    IF orchestrator_id IS NOT NULL THEN
        -- Orchestrator gets all internal tools + read-only CRM tools
        FOR tool_rec IN
            SELECT id FROM tool_library
            WHERE category = 'internal'
               OR (category = 'crm' AND risk_level = 'low')
        LOOP
            INSERT INTO agent_tool_permissions (agent_config_id, tool_id, granted_by)
            VALUES (orchestrator_id, tool_rec.id, 'system')
            ON CONFLICT (agent_config_id, tool_id) DO NOTHING;
        END LOOP;
    END IF;
END $$;

-- Grant SDR Agent access to CRM tools
DO $$
DECLARE
    agent_id UUID;
    tool_rec RECORD;
BEGIN
    SELECT id INTO agent_id FROM agent_configs WHERE name = 'SDR Agent' LIMIT 1;

    IF agent_id IS NOT NULL THEN
        FOR tool_rec IN
            SELECT id FROM tool_library
            WHERE name IN ('search_contacts', 'search_companies', 'get_contact_brief',
                          'get_company_brief', 'create_company', 'update_score')
        LOOP
            INSERT INTO agent_tool_permissions (agent_config_id, tool_id, granted_by)
            VALUES (agent_id, tool_rec.id, 'system')
            ON CONFLICT (agent_config_id, tool_id) DO NOTHING;
        END LOOP;
    END IF;
END $$;

-- Grant Scoring Agent access to relevant tools
DO $$
DECLARE
    agent_id UUID;
    tool_rec RECORD;
BEGIN
    SELECT id INTO agent_id FROM agent_configs WHERE name = 'Scoring Agent' LIMIT 1;

    IF agent_id IS NOT NULL THEN
        FOR tool_rec IN
            SELECT id FROM tool_library
            WHERE name IN ('get_contact_brief', 'get_company_brief', 'update_score')
        LOOP
            INSERT INTO agent_tool_permissions (agent_config_id, tool_id, granted_by)
            VALUES (agent_id, tool_rec.id, 'system')
            ON CONFLICT (agent_config_id, tool_id) DO NOTHING;
        END LOOP;
    END IF;
END $$;

-- Grant Outreach Agent access to relevant tools
DO $$
DECLARE
    agent_id UUID;
    tool_rec RECORD;
BEGIN
    SELECT id INTO agent_id FROM agent_configs WHERE name = 'Outreach Agent' LIMIT 1;

    IF agent_id IS NOT NULL THEN
        FOR tool_rec IN
            SELECT id FROM tool_library
            WHERE name IN ('search_contacts', 'get_contact_brief', 'create_task',
                          'list_open_tasks', 'log_interaction')
        LOOP
            INSERT INTO agent_tool_permissions (agent_config_id, tool_id, granted_by)
            VALUES (agent_id, tool_rec.id, 'system')
            ON CONFLICT (agent_config_id, tool_id) DO NOTHING;
        END LOOP;
    END IF;
END $$;

-- Grant Data Agent access to read-only tools
DO $$
DECLARE
    agent_id UUID;
    tool_rec RECORD;
BEGIN
    SELECT id INTO agent_id FROM agent_configs WHERE name = 'Data Agent' LIMIT 1;

    IF agent_id IS NOT NULL THEN
        FOR tool_rec IN
            SELECT id FROM tool_library
            WHERE name IN ('search_contacts', 'search_companies', 'get_recent_agent_activity',
                          'list_open_tasks', 'get_call_list')
        LOOP
            INSERT INTO agent_tool_permissions (agent_config_id, tool_id, granted_by)
            VALUES (agent_id, tool_rec.id, 'system')
            ON CONFLICT (agent_config_id, tool_id) DO NOTHING;
        END LOOP;
    END IF;
END $$;

-- Grant Lead Sourcing Agent access to create tools
DO $$
DECLARE
    agent_id UUID;
    tool_rec RECORD;
BEGIN
    SELECT id INTO agent_id FROM agent_configs WHERE name = 'Lead Sourcing Agent' LIMIT 1;

    IF agent_id IS NOT NULL THEN
        FOR tool_rec IN
            SELECT id FROM tool_library
            WHERE name IN ('create_contact', 'create_company', 'search_contacts', 'search_companies')
        LOOP
            INSERT INTO agent_tool_permissions (agent_config_id, tool_id, granted_by)
            VALUES (agent_id, tool_rec.id, 'system')
            ON CONFLICT (agent_config_id, tool_id) DO NOTHING;
        END LOOP;
    END IF;
END $$;

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS tool_library_category_idx ON tool_library(category);
CREATE INDEX IF NOT EXISTS tool_library_enabled_idx ON tool_library(is_enabled);
CREATE INDEX IF NOT EXISTS integrations_team_idx ON integrations(team_id);
CREATE INDEX IF NOT EXISTS agent_tool_permissions_agent_idx ON agent_tool_permissions(agent_config_id);
CREATE INDEX IF NOT EXISTS agent_tool_permissions_tool_idx ON agent_tool_permissions(tool_id);
CREATE INDEX IF NOT EXISTS tool_executions_agent_idx ON tool_executions(agent_config_id);
CREATE INDEX IF NOT EXISTS tool_executions_run_idx ON tool_executions(agent_run_id);
CREATE INDEX IF NOT EXISTS tool_executions_time_idx ON tool_executions(started_at DESC);

-- ============================================================================
-- HELPER VIEWS
-- ============================================================================

-- View: Agent capabilities (what tools each agent can use)
CREATE OR REPLACE VIEW agent_capabilities AS
SELECT
    ac.id as agent_id,
    ac.name as agent_name,
    ac.is_enabled as agent_enabled,
    tl.id as tool_id,
    tl.name as tool_name,
    tl.display_name as tool_display_name,
    tl.category as tool_category,
    tl.risk_level,
    atp.permission_level,
    tl.is_enabled as tool_enabled,
    tl.requires_auth,
    tl.auth_config_key
FROM agent_configs ac
JOIN agent_tool_permissions atp ON atp.agent_config_id = ac.id
JOIN tool_library tl ON tl.id = atp.tool_id;

-- View: Integration status (what's connected)
CREATE OR REPLACE VIEW integration_status AS
SELECT
    it.name,
    it.display_name,
    it.category,
    it.description,
    COALESCE(i.is_connected, false) as is_connected,
    COALESCE(i.is_enabled, false) as is_enabled,
    i.last_tested_at,
    i.last_error,
    it.setup_instructions
FROM integration_templates it
LEFT JOIN integrations i ON i.name = it.name;
