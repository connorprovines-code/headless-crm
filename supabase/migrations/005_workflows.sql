-- Migration 005: Workflow System + More Event Triggers
-- Reusable workflow blueprints that agents execute

-- ============================================================================
-- WORKFLOW TEMPLATES
-- ============================================================================
-- These are the "recipes" - reusable workflow definitions

CREATE TABLE IF NOT EXISTS workflow_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identity
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL, -- e.g., 'sdr_new_contact', 'score_after_call'
    description TEXT,

    -- Categorization
    category VARCHAR(50) DEFAULT 'general',
    -- Categories: enrichment, scoring, outreach, data_quality, notification

    -- When this workflow applies
    trigger_event VARCHAR(100), -- e.g., 'contact.created', 'interaction.logged'

    -- Version control
    version INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT true,
    is_system BOOLEAN DEFAULT true, -- System workflows can't be deleted

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- WORKFLOW STEPS
-- ============================================================================
-- Ordered steps within a workflow

CREATE TABLE IF NOT EXISTS workflow_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_template_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,

    -- Step identity
    name VARCHAR(200) NOT NULL,
    description TEXT,
    step_order INTEGER NOT NULL, -- Execution order (1, 2, 3...)

    -- What this step does
    action_type VARCHAR(50) NOT NULL,
    -- Types: tool_call, condition_check, ai_prompt, wait, branch, loop

    action_config JSONB NOT NULL DEFAULT '{}',
    -- For tool_call: { tool_name, input_mapping }
    -- For condition_check: { conditions, on_true_goto, on_false_goto }
    -- For ai_prompt: { prompt_template, output_variable }
    -- For wait: { duration_seconds }
    -- For branch: { branches: [{condition, goto_step}] }

    -- Conditions to run this step (optional)
    run_conditions JSONB DEFAULT '[]',
    -- [{"field": "{{contact.email}}", "operator": "is_not_empty"}]

    -- Error handling
    on_error VARCHAR(50) DEFAULT 'continue', -- continue, stop, retry, goto_step
    error_config JSONB DEFAULT '{}',

    -- Output
    output_variable VARCHAR(100), -- Store result as variable for later steps

    -- Status
    is_enabled BOOLEAN DEFAULT true,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- WORKFLOW RUNS
-- ============================================================================
-- Track each execution of a workflow

CREATE TABLE IF NOT EXISTS workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_template_id UUID REFERENCES workflow_templates(id) ON DELETE SET NULL,
    agent_config_id UUID REFERENCES agent_configs(id) ON DELETE SET NULL,

    -- Context
    trigger_event_id UUID REFERENCES events(id) ON DELETE SET NULL,
    entity_type VARCHAR(50),
    entity_id UUID,

    -- Execution state
    status VARCHAR(20) DEFAULT 'pending',
    -- pending, running, completed, failed, cancelled
    current_step INTEGER DEFAULT 0,

    -- Variables (accumulated during execution)
    variables JSONB DEFAULT '{}',
    -- { "contact": {...}, "company_lookup": {...}, "enrichment_result": {...} }

    -- Results
    steps_completed INTEGER DEFAULT 0,
    steps_failed INTEGER DEFAULT 0,

    -- Timing
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    -- Errors
    error_message TEXT,
    error_step_id UUID,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- WORKFLOW STEP LOGS
-- ============================================================================
-- Detailed log of each step execution

CREATE TABLE IF NOT EXISTS workflow_step_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workflow_step_id UUID REFERENCES workflow_steps(id) ON DELETE SET NULL,

    step_order INTEGER,
    step_name VARCHAR(200),
    action_type VARCHAR(50),

    -- Execution
    status VARCHAR(20), -- pending, running, completed, skipped, failed
    input JSONB,
    output JSONB,
    error_message TEXT,

    -- Timing
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PROMPT TEMPLATES
-- ============================================================================
-- Reusable AI prompts for agents

CREATE TABLE IF NOT EXISTS prompt_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,

    -- The prompt itself (supports {{variable}} substitution)
    prompt_text TEXT NOT NULL,

    -- What model/settings to use
    model VARCHAR(50) DEFAULT 'claude-sonnet-4-20250514',
    max_tokens INTEGER DEFAULT 1024,
    temperature NUMERIC DEFAULT 0.7,

    -- Output parsing
    output_type VARCHAR(20) DEFAULT 'text', -- text, json, boolean, number
    output_schema JSONB, -- For JSON output, the expected structure

    -- Categorization
    category VARCHAR(50),

    -- Status
    is_active BOOLEAN DEFAULT true,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- MORE EVENT TRIGGERS
-- ============================================================================

-- Company created trigger
CREATE OR REPLACE FUNCTION company_created_trigger() RETURNS TRIGGER AS $$
BEGIN
    PERFORM emit_event(
        NEW.team_id,
        'company.created',
        'company',
        NEW.id,
        jsonb_build_object(
            'name', NEW.name,
            'domain', NEW.domain,
            'industry', NEW.industry
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_company_created ON companies;
CREATE TRIGGER on_company_created
    AFTER INSERT ON companies
    FOR EACH ROW EXECUTE FUNCTION company_created_trigger();

-- Contact updated trigger
CREATE OR REPLACE FUNCTION contact_updated_trigger() RETURNS TRIGGER AS $$
BEGIN
    -- Only emit if meaningful fields changed
    IF OLD.score != NEW.score OR OLD.status != NEW.status OR OLD.company_id != NEW.company_id THEN
        PERFORM emit_event(
            NEW.team_id,
            'contact.updated',
            'contact',
            NEW.id,
            jsonb_build_object(
                'changes', jsonb_build_object(
                    'score', CASE WHEN OLD.score != NEW.score THEN jsonb_build_object('old', OLD.score, 'new', NEW.score) END,
                    'status', CASE WHEN OLD.status != NEW.status THEN jsonb_build_object('old', OLD.status, 'new', NEW.status) END,
                    'company_id', CASE WHEN OLD.company_id != NEW.company_id THEN jsonb_build_object('old', OLD.company_id, 'new', NEW.company_id) END
                )
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_contact_updated ON contacts;
CREATE TRIGGER on_contact_updated
    AFTER UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION contact_updated_trigger();

-- Deal stage changed trigger
CREATE OR REPLACE FUNCTION deal_stage_changed_trigger() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.stage != NEW.stage THEN
        PERFORM emit_event(
            NEW.team_id,
            'deal.stage_changed',
            'deal',
            NEW.id,
            jsonb_build_object(
                'old_stage', OLD.stage,
                'new_stage', NEW.stage,
                'company_id', NEW.company_id,
                'value', NEW.value
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_deal_stage_changed ON deals;
CREATE TRIGGER on_deal_stage_changed
    AFTER UPDATE ON deals
    FOR EACH ROW EXECUTE FUNCTION deal_stage_changed_trigger();

-- Task completed trigger
CREATE OR REPLACE FUNCTION task_completed_trigger() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN
        PERFORM emit_event(
            NEW.team_id,
            'task.completed',
            'task',
            NEW.id,
            jsonb_build_object(
                'type', NEW.type,
                'contact_id', NEW.contact_id,
                'company_id', NEW.company_id
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_task_completed ON tasks;
CREATE TRIGGER on_task_completed
    AFTER UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION task_completed_trigger();

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS wt_slug_idx ON workflow_templates(slug);
CREATE INDEX IF NOT EXISTS wt_trigger_idx ON workflow_templates(trigger_event);
CREATE INDEX IF NOT EXISTS wt_active_idx ON workflow_templates(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS ws_workflow_idx ON workflow_steps(workflow_template_id);
CREATE INDEX IF NOT EXISTS ws_order_idx ON workflow_steps(workflow_template_id, step_order);

CREATE INDEX IF NOT EXISTS wr_workflow_idx ON workflow_runs(workflow_template_id);
CREATE INDEX IF NOT EXISTS wr_status_idx ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS wr_entity_idx ON workflow_runs(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS wsl_run_idx ON workflow_step_logs(workflow_run_id);

CREATE INDEX IF NOT EXISTS pt_slug_idx ON prompt_templates(slug);

-- ============================================================================
-- LINK WORKFLOWS TO AGENTS
-- ============================================================================

-- Add workflow reference to agent_configs
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS workflow_template_id UUID REFERENCES workflow_templates(id) ON DELETE SET NULL;

-- ============================================================================
-- SEED: SDR AGENT WORKFLOW (placeholder - we'll define together)
-- ============================================================================

INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system)
VALUES (
    'SDR New Contact Processing',
    'sdr_new_contact',
    'When a new contact is created: extract company from email, link to company, check for duplicates, enrich if possible, set initial score',
    'enrichment',
    'contact.created',
    true
) ON CONFLICT (slug) DO NOTHING;

-- Placeholder for steps - we'll define these together
-- INSERT INTO workflow_steps ...

-- ============================================================================
-- HELPER VIEW: Workflow status
-- ============================================================================

CREATE OR REPLACE VIEW workflow_status AS
SELECT
    wt.id as workflow_id,
    wt.name as workflow_name,
    wt.slug,
    wt.trigger_event,
    wt.is_active,
    COUNT(DISTINCT ws.id) as step_count,
    COUNT(DISTINCT wr.id) FILTER (WHERE wr.created_at > NOW() - INTERVAL '24 hours') as runs_24h,
    COUNT(DISTINCT wr.id) FILTER (WHERE wr.status = 'failed' AND wr.created_at > NOW() - INTERVAL '24 hours') as failures_24h
FROM workflow_templates wt
LEFT JOIN workflow_steps ws ON ws.workflow_template_id = wt.id
LEFT JOIN workflow_runs wr ON wr.workflow_template_id = wt.id
GROUP BY wt.id, wt.name, wt.slug, wt.trigger_event, wt.is_active;
