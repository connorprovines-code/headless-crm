-- Migration 003: Default System Agents + Rollback Support
-- These are the core agents that power the headless CRM

-- ============================================================================
-- ADD ROLLBACK SUPPORT TO AGENT CONFIGS
-- ============================================================================

-- Store previous config for easy rollback
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS previous_config JSONB;

-- System flag - can't be deleted, only disabled
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT false;

-- Agent capabilities - what tools/actions this agent can perform
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '[]'::jsonb;

-- Parent agent (for hierarchy)
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS parent_agent_id UUID REFERENCES agent_configs(id) ON DELETE SET NULL;

-- Priority for execution order
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 50;

-- ============================================================================
-- TRIGGER: Auto-save previous config on update
-- ============================================================================

CREATE OR REPLACE FUNCTION save_previous_agent_config()
RETURNS TRIGGER AS $$
BEGIN
    NEW.previous_config = jsonb_build_object(
        'name', OLD.name,
        'description', OLD.description,
        'trigger_type', OLD.trigger_type,
        'trigger_config', OLD.trigger_config,
        'conditions', OLD.conditions,
        'actions', OLD.actions,
        'allowed_tools', OLD.allowed_tools,
        'is_enabled', OLD.is_enabled,
        'capabilities', OLD.capabilities,
        'saved_at', NOW()
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_config_save_previous ON agent_configs;
CREATE TRIGGER agent_config_save_previous
    BEFORE UPDATE ON agent_configs
    FOR EACH ROW
    EXECUTE FUNCTION save_previous_agent_config();

-- ============================================================================
-- DEFAULT SYSTEM AGENTS
-- ============================================================================

-- 1. ORCHESTRATOR AGENT (Meta-Agent)
INSERT INTO agent_configs (
    name, description, trigger_type, trigger_config, conditions, actions, allowed_tools, capabilities, is_enabled, is_system, priority
) VALUES (
    'Orchestrator',
    'Meta-agent that manages all other agents. Routes your requests, generates reports, and can operate autonomously. Talk to this one.',
    'manual', '{}', '[]',
    '[]'::jsonb,
    '["list_agents", "get_agent_details", "update_agent", "get_recent_agent_activity", "get_pending_events", "get_call_list", "search_contacts", "search_companies", "get_company_brief", "get_contact_brief"]'::jsonb,
    '[{"name": "manage_agents", "description": "Enable, disable, and configure other agents"}, {"name": "generate_reports", "description": "Request reports from Data Agent"}, {"name": "trigger_enrichment", "description": "Ask SDR Agent to enrich specific contacts"}, {"name": "generate_call_list", "description": "Create prioritized call lists based on current data"}, {"name": "surface_insights", "description": "Summarize recent activity and notable changes"}]'::jsonb,
    true, true, 1
) ON CONFLICT DO NOTHING;

-- 2. SDR AGENT
INSERT INTO agent_configs (
    name, description, trigger_type, trigger_config, conditions, actions, allowed_tools, capabilities, is_enabled, is_system, priority
) VALUES (
    'SDR Agent',
    'Handles lead enrichment and data quality. Automatically enriches new contacts, fills missing fields, deduplicates records, and links contacts to companies.',
    'event', '{"events": ["contact.created", "company.created"]}'::jsonb, '[]',
    '[{"type": "enrich_contact", "description": "Fill missing contact fields from available data"}, {"type": "link_company", "description": "Auto-link contact to company based on email domain"}, {"type": "dedupe_check", "description": "Check for duplicate contacts"}, {"type": "validate_email", "description": "Validate email format and deliverability"}]'::jsonb,
    '["search_contacts", "search_companies", "create_company", "get_contact_brief", "get_company_brief", "set_custom_field_value"]'::jsonb,
    '[{"name": "enrich_contact", "description": "Fill missing contact fields (title, phone, LinkedIn)"}, {"name": "enrich_company", "description": "Fill missing company fields (industry, size, domain)"}, {"name": "deduplicate", "description": "Find and merge duplicate records"}, {"name": "link_to_company", "description": "Auto-associate contacts with companies via email domain"}, {"name": "validate_data", "description": "Check data quality and flag issues"}]'::jsonb,
    false, true, 10
) ON CONFLICT DO NOTHING;

-- 3. SCORING AGENT
INSERT INTO agent_configs (
    name, description, trigger_type, trigger_config, conditions, actions, allowed_tools, capabilities, is_enabled, is_system, priority
) VALUES (
    'Scoring Agent',
    'Maintains lead and account scores. Fires after interactions, signals, or data changes to recalculate scores based on ICP fit, engagement level, and buying signals.',
    'event', '{"events": ["interaction.logged", "signal.created", "contact.updated", "company.updated"]}'::jsonb, '[]',
    '[{"type": "calculate_engagement_score", "description": "Score based on interaction frequency and recency"}, {"type": "calculate_icp_fit", "description": "Score based on company size, industry, role match"}, {"type": "calculate_buying_signals", "description": "Score based on intent signals"}, {"type": "update_score", "description": "Write final composite score to contact/company"}]'::jsonb,
    '["get_contact_brief", "get_company_brief", "update_score", "get_custom_fields", "list_custom_field_values"]'::jsonb,
    '[{"name": "score_contact", "description": "Calculate and update contact score (0-100)"}, {"name": "score_company", "description": "Calculate and update company/account score (0-100)"}, {"name": "identify_hot_leads", "description": "Flag contacts that cross score thresholds"}, {"name": "decay_scores", "description": "Reduce scores for stale contacts with no recent activity"}]'::jsonb,
    false, true, 20
) ON CONFLICT DO NOTHING;

-- 4. OUTREACH AGENT
INSERT INTO agent_configs (
    name, description, trigger_type, trigger_config, conditions, actions, allowed_tools, capabilities, is_enabled, is_system, priority
) VALUES (
    'Outreach Agent',
    'Manages outreach cadences and follow-ups. Generates tasks for next touches, suggests messaging, and tracks sequence progress.',
    'schedule', '{"cron": "0 7 * * 1-5", "description": "Runs every weekday at 7am"}'::jsonb, '[]',
    '[{"type": "generate_follow_ups", "description": "Create follow-up tasks for stale conversations"}, {"type": "advance_sequence", "description": "Move contacts through outreach sequences"}, {"type": "suggest_messaging", "description": "Generate personalized outreach suggestions"}]'::jsonb,
    '["search_contacts", "get_contact_brief", "create_task", "list_open_tasks", "log_interaction"]'::jsonb,
    '[{"name": "generate_follow_ups", "description": "Create tasks for contacts needing follow-up"}, {"name": "manage_sequences", "description": "Track and advance multi-touch sequences"}, {"name": "suggest_messaging", "description": "Generate personalized message suggestions"}, {"name": "prioritize_outreach", "description": "Rank contacts by outreach priority"}]'::jsonb,
    false, true, 30
) ON CONFLICT DO NOTHING;

-- 5. DATA AGENT
INSERT INTO agent_configs (
    name, description, trigger_type, trigger_config, conditions, actions, allowed_tools, capabilities, is_enabled, is_system, priority
) VALUES (
    'Data Agent',
    'Generates reports and analytics. Creates daily activity digests, weekly pipeline summaries, and surfaces notable trends or anomalies.',
    'schedule', '{"cron": "0 8 * * *", "description": "Runs daily at 8am"}'::jsonb, '[]',
    '[{"type": "daily_digest", "description": "Summarize yesterday activity"}, {"type": "weekly_summary", "description": "Weekly pipeline and performance report"}, {"type": "anomaly_detection", "description": "Flag unusual patterns"}]'::jsonb,
    '["search_contacts", "search_companies", "get_recent_agent_activity", "list_open_tasks", "get_call_list"]'::jsonb,
    '[{"name": "daily_digest", "description": "Generate daily activity summary"}, {"name": "weekly_report", "description": "Generate weekly pipeline and metrics report"}, {"name": "activity_summary", "description": "Summarize interactions by type, outcome, sentiment"}, {"name": "pipeline_snapshot", "description": "Current state of deals and opportunities"}, {"name": "trend_analysis", "description": "Identify trends in engagement, conversion, activity"}]'::jsonb,
    false, true, 40
) ON CONFLICT DO NOTHING;

-- 6. LEAD SOURCING AGENT
INSERT INTO agent_configs (
    name, description, trigger_type, trigger_config, conditions, actions, allowed_tools, capabilities, is_enabled, is_system, priority
) VALUES (
    'Lead Sourcing Agent',
    'Imports and processes leads from external sources. Handles CSV imports, API integrations, and web scraping (when configured).',
    'manual', '{}', '[]',
    '[{"type": "import_csv", "description": "Process uploaded CSV files"}, {"type": "api_import", "description": "Pull leads from configured APIs"}, {"type": "web_scrape", "description": "Extract leads from configured sources"}]'::jsonb,
    '["create_contact", "create_company", "search_contacts", "search_companies"]'::jsonb,
    '[{"name": "import_csv", "description": "Import contacts from CSV file"}, {"name": "import_api", "description": "Import from external APIs (Apollo, LinkedIn, etc.)"}, {"name": "web_scrape", "description": "Extract leads from websites (requires config)"}, {"name": "dedupe_on_import", "description": "Check for duplicates during import"}]'::jsonb,
    false, true, 50
) ON CONFLICT DO NOTHING;

-- ============================================================================
-- SET PARENT RELATIONSHIPS (Orchestrator is parent of all)
-- ============================================================================

DO $$
DECLARE
    orchestrator_id UUID;
BEGIN
    SELECT id INTO orchestrator_id FROM agent_configs WHERE name = 'Orchestrator' LIMIT 1;
    IF orchestrator_id IS NOT NULL THEN
        UPDATE agent_configs
        SET parent_agent_id = orchestrator_id
        WHERE name IN ('SDR Agent', 'Scoring Agent', 'Outreach Agent', 'Data Agent', 'Lead Sourcing Agent')
        AND parent_agent_id IS NULL;
    END IF;
END $$;

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS agent_configs_is_system_idx ON agent_configs(is_system);
CREATE INDEX IF NOT EXISTS agent_configs_parent_idx ON agent_configs(parent_agent_id);
CREATE INDEX IF NOT EXISTS agent_configs_priority_idx ON agent_configs(priority);
