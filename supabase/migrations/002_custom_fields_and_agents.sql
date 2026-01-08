-- Migration 002: Custom Fields + Agent Configuration
-- This enables dynamic field creation and agent management

-- ============================================================================
-- CUSTOM FIELDS SYSTEM
-- Allows teams to define custom fields on any entity without schema changes
-- ============================================================================

CREATE TABLE custom_fields (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('contact', 'company', 'deal')),
    field_name TEXT NOT NULL,
    field_label TEXT,                    -- Display name (e.g., "Deal Stage" vs "deal_stage")
    field_type TEXT NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'boolean', 'select', 'multi_select', 'url', 'email', 'phone')),
    description TEXT,                    -- Help text for the field
    options JSONB,                       -- For select/multi_select: ["Option A", "Option B"]
    default_value TEXT,                  -- Default value for new records
    is_required BOOLEAN DEFAULT FALSE,
    is_visible BOOLEAN DEFAULT TRUE,     -- Can be hidden from normal views
    sort_order INTEGER DEFAULT 0,        -- For ordering in UI
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(team_id, entity_type, field_name)
);

CREATE TABLE custom_field_values (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    custom_field_id UUID REFERENCES custom_fields(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL,             -- The contact/company/deal ID
    value_text TEXT,
    value_number NUMERIC,
    value_date DATE,
    value_boolean BOOLEAN,
    value_json JSONB,                    -- For multi_select and complex values
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(custom_field_id, entity_id)
);

-- Indexes for custom fields
CREATE INDEX cf_team_entity_idx ON custom_fields(team_id, entity_type);
CREATE INDEX cfv_entity_idx ON custom_field_values(entity_id);
CREATE INDEX cfv_field_idx ON custom_field_values(custom_field_id);
CREATE INDEX cfv_text_idx ON custom_field_values(value_text) WHERE value_text IS NOT NULL;
CREATE INDEX cfv_number_idx ON custom_field_values(value_number) WHERE value_number IS NOT NULL;
CREATE INDEX cfv_date_idx ON custom_field_values(value_date) WHERE value_date IS NOT NULL;

-- Trigger for updated_at
CREATE TRIGGER custom_fields_updated_at
    BEFORE UPDATE ON custom_fields
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER custom_field_values_updated_at
    BEFORE UPDATE ON custom_field_values
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- AGENT CONFIGURATION SYSTEM
-- Defines agent behaviors, triggers, and capabilities
-- ============================================================================

CREATE TABLE agent_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

    -- Basic info
    name TEXT NOT NULL,
    description TEXT,
    is_enabled BOOLEAN DEFAULT TRUE,
    is_system BOOLEAN DEFAULT FALSE,     -- System agents can't be deleted by users

    -- Trigger configuration
    trigger_type TEXT NOT NULL CHECK (trigger_type IN (
        'manual',                        -- Only runs when explicitly called
        'event',                         -- Runs on specific events
        'schedule',                      -- Runs on a schedule
        'chained'                        -- Runs after another agent completes
    )),
    trigger_config JSONB NOT NULL DEFAULT '{}',
    -- For 'event': {"events": ["contact.created", "interaction.logged"]}
    -- For 'schedule': {"cron": "0 8 * * *", "timezone": "America/New_York"}
    -- For 'chained': {"after_agent": "uuid", "condition": "success"}

    -- Conditions (when should this agent actually run)
    conditions JSONB DEFAULT '[]',
    -- [{"field": "contact.score", "operator": ">", "value": 50}]
    -- [{"field": "company.industry", "operator": "equals", "value": "SaaS"}]

    -- Actions (what the agent does)
    actions JSONB NOT NULL DEFAULT '[]',
    -- [{"type": "update_field", "target": "contact.score", "operation": "increment", "value": 10}]
    -- [{"type": "create_task", "task_type": "call", "priority": 3, "reason_template": "Follow up on {{interaction.subject}}"}]
    -- [{"type": "send_notification", "channel": "slack", "template": "New hot lead: {{contact.name}}"}]
    -- [{"type": "run_prompt", "prompt": "Analyze this contact and suggest next steps", "output_field": "contact.notes"}]

    -- Allowed tools (limits what the agent can do)
    allowed_tools JSONB DEFAULT '[]',
    -- ["search_contacts", "update_score", "create_task"]
    -- Empty array means all tools allowed

    -- Execution settings
    max_executions_per_hour INTEGER DEFAULT 100,
    timeout_seconds INTEGER DEFAULT 60,
    retry_on_failure BOOLEAN DEFAULT FALSE,
    max_retries INTEGER DEFAULT 3,

    -- Metadata
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    last_run_at TIMESTAMPTZ,
    run_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent execution history (separate from agent_logs for detailed tracking)
CREATE TABLE agent_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_config_id UUID REFERENCES agent_configs(id) ON DELETE CASCADE,
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

    -- Execution details
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    trigger_event JSONB,                 -- What triggered this run

    -- Results
    actions_taken JSONB DEFAULT '[]',    -- Log of what actions were performed
    entities_affected INTEGER DEFAULT 0,
    tokens_used INTEGER DEFAULT 0,       -- Track AI usage for cost

    -- Timing
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,

    -- Errors
    error_message TEXT,
    error_details JSONB,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for agent tables
CREATE INDEX ac_team_idx ON agent_configs(team_id);
CREATE INDEX ac_enabled_idx ON agent_configs(is_enabled) WHERE is_enabled = TRUE;
CREATE INDEX ac_trigger_type_idx ON agent_configs(trigger_type);

CREATE INDEX ar_agent_idx ON agent_runs(agent_config_id);
CREATE INDEX ar_team_idx ON agent_runs(team_id);
CREATE INDEX ar_status_idx ON agent_runs(status);
CREATE INDEX ar_created_idx ON agent_runs(created_at DESC);

-- Trigger for updated_at
CREATE TRIGGER agent_configs_updated_at
    BEFORE UPDATE ON agent_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- EVENT SYSTEM
-- Captures events that can trigger agents
-- ============================================================================

CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

    event_type TEXT NOT NULL,            -- "contact.created", "interaction.logged", "score.changed", etc.
    entity_type TEXT,
    entity_id UUID,

    payload JSONB NOT NULL DEFAULT '{}', -- Event-specific data

    -- Processing status
    processed BOOLEAN DEFAULT FALSE,
    processed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX events_unprocessed_idx ON events(team_id, event_type) WHERE processed = FALSE;
CREATE INDEX events_created_idx ON events(created_at DESC);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to emit an event (call this after mutations)
CREATE OR REPLACE FUNCTION emit_event(
    p_team_id UUID,
    p_event_type TEXT,
    p_entity_type TEXT,
    p_entity_id UUID,
    p_payload JSONB DEFAULT '{}'
) RETURNS UUID AS $$
DECLARE
    v_event_id UUID;
BEGIN
    INSERT INTO events (team_id, event_type, entity_type, entity_id, payload)
    VALUES (p_team_id, p_event_type, p_entity_type, p_entity_id, p_payload)
    RETURNING id INTO v_event_id;

    RETURN v_event_id;
END;
$$ LANGUAGE plpgsql;

-- Example trigger to emit events on contact creation
CREATE OR REPLACE FUNCTION contact_created_trigger() RETURNS TRIGGER AS $$
BEGIN
    PERFORM emit_event(
        NEW.team_id,
        'contact.created',
        'contact',
        NEW.id,
        jsonb_build_object(
            'first_name', NEW.first_name,
            'last_name', NEW.last_name,
            'email', NEW.email,
            'company_id', NEW.company_id
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_contact_created
    AFTER INSERT ON contacts
    FOR EACH ROW EXECUTE FUNCTION contact_created_trigger();

-- Similar trigger for interactions
CREATE OR REPLACE FUNCTION interaction_logged_trigger() RETURNS TRIGGER AS $$
BEGIN
    PERFORM emit_event(
        NEW.team_id,
        'interaction.logged',
        'interaction',
        NEW.id,
        jsonb_build_object(
            'type', NEW.type,
            'contact_id', NEW.contact_id,
            'company_id', NEW.company_id,
            'sentiment', NEW.sentiment,
            'outcome', NEW.outcome
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_interaction_logged
    AFTER INSERT ON interactions
    FOR EACH ROW EXECUTE FUNCTION interaction_logged_trigger();
