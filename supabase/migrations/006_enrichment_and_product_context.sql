-- Migration 006: Enrichment Infrastructure + Product Context
-- Adds tables for: product context, enrichment tracking, rate limiting, new integrations

-- ============================================================================
-- PRODUCT CONTEXT
-- ============================================================================
-- Stores product/company information that agents use for personalization

CREATE TABLE IF NOT EXISTS product_context (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

    -- Identity
    name VARCHAR(200) NOT NULL,  -- "Main Product" or vertical name
    slug VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    is_default BOOLEAN DEFAULT false,  -- Default context for team

    -- Product Information
    description TEXT,            -- What the product does
    value_proposition TEXT,      -- Core value prop / elevator pitch
    ideal_customer TEXT,         -- ICP description
    pain_points TEXT,            -- Problems we solve (can be bullet points)
    differentiators TEXT,        -- Why us vs competitors
    pricing_info TEXT,           -- Optional pricing context

    -- Additional context (flexible)
    custom_context JSONB DEFAULT '{}',
    -- e.g., { "competitors": [...], "case_studies": [...], "objection_handling": {...} }

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one default per team
CREATE UNIQUE INDEX IF NOT EXISTS pc_default_per_team ON product_context(team_id) WHERE is_default = true;
CREATE INDEX IF NOT EXISTS pc_team_idx ON product_context(team_id);
CREATE INDEX IF NOT EXISTS pc_active_idx ON product_context(is_active) WHERE is_active = true;

-- ============================================================================
-- ENRICHMENT STATUS ON CONTACTS
-- ============================================================================
-- Track enrichment progress per contact

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_status VARCHAR(20) DEFAULT 'pending';
-- pending, in_progress, complete, partial, failed

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_data JSONB DEFAULT '{}';
-- Stores raw enrichment results: { "pdl": {...}, "apollo": {...}, "linkedin": {...}, "perplexity": {...} }

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_errors JSONB DEFAULT '[]';
-- Array of errors: [{ "source": "apollo", "error": "rate limited", "at": "2024-..." }]

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;

-- ============================================================================
-- ENRICHMENT STATUS ON COMPANIES
-- ============================================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS enrichment_status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enrichment_data JSONB DEFAULT '{}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enrichment_errors JSONB DEFAULT '[]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;

-- ============================================================================
-- API RATE LIMITING
-- ============================================================================
-- Track API calls to prevent hitting rate limits

CREATE TABLE IF NOT EXISTS api_rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

    integration_name VARCHAR(100) NOT NULL,  -- pdl, apollo, hunter, apify, perplexity

    -- Rate limit config (can be updated per integration)
    requests_per_minute INTEGER DEFAULT 60,
    requests_per_hour INTEGER DEFAULT 1000,
    requests_per_day INTEGER DEFAULT 10000,

    -- Current usage (reset periodically)
    minute_count INTEGER DEFAULT 0,
    minute_reset_at TIMESTAMPTZ DEFAULT NOW(),
    hour_count INTEGER DEFAULT 0,
    hour_reset_at TIMESTAMPTZ DEFAULT NOW(),
    day_count INTEGER DEFAULT 0,
    day_reset_at TIMESTAMPTZ DEFAULT NOW(),

    -- Tracking
    total_requests INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    last_request_at TIMESTAMPTZ,
    last_error_at TIMESTAMPTZ,
    last_error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(team_id, integration_name)
);

CREATE INDEX IF NOT EXISTS arl_team_idx ON api_rate_limits(team_id);
CREATE INDEX IF NOT EXISTS arl_integration_idx ON api_rate_limits(integration_name);

-- ============================================================================
-- ENRICHMENT QUEUE
-- ============================================================================
-- Queue for enrichment jobs (allows async processing)

CREATE TABLE IF NOT EXISTS enrichment_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

    -- What to enrich
    entity_type VARCHAR(20) NOT NULL,  -- contact, company
    entity_id UUID NOT NULL,

    -- Job details
    source VARCHAR(50) NOT NULL,  -- pdl, apollo, hunter, apify_linkedin, perplexity
    priority INTEGER DEFAULT 5,   -- 1 = highest

    -- Status
    status VARCHAR(20) DEFAULT 'pending',  -- pending, processing, completed, failed, skipped
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,

    -- Input/Output
    input_data JSONB DEFAULT '{}',  -- What we're searching for
    output_data JSONB,              -- Result from API
    error_message TEXT,

    -- Timing
    scheduled_for TIMESTAMPTZ DEFAULT NOW(),  -- For delayed/retry scheduling
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS eq_status_idx ON enrichment_queue(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS eq_entity_idx ON enrichment_queue(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS eq_scheduled_idx ON enrichment_queue(scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS eq_priority_idx ON enrichment_queue(priority, scheduled_for) WHERE status = 'pending';

-- ============================================================================
-- NEW INTEGRATION TEMPLATES
-- ============================================================================

INSERT INTO integration_templates (name, display_name, category, description, auth_type, auth_config, default_settings)
VALUES
    ('peopledatalabs', 'People Data Labs', 'enrichment',
     'Person and company enrichment API. Find work emails, job titles, company info.',
     'api_key',
     '{"header_name": "X-Api-Key"}',
     '{"base_url": "https://api.peopledatalabs.com/v5"}'),

    ('hunter', 'Hunter.io', 'enrichment',
     'Email finder and verifier. Find email addresses and verify deliverability.',
     'api_key',
     '{"query_param": "api_key"}',
     '{"base_url": "https://api.hunter.io/v2"}'),

    ('apollo_enrichment', 'Apollo (Enrichment)', 'enrichment',
     'B2B contact and company enrichment. Job titles, company data, contact info.',
     'api_key',
     '{"header_name": "X-Api-Key"}',
     '{"base_url": "https://api.apollo.io/v1"}'),

    ('apify', 'Apify', 'enrichment',
     'Web scraping platform. Used for LinkedIn profile scraping.',
     'api_key',
     '{"query_param": "token"}',
     '{"base_url": "https://api.apify.com/v2", "linkedin_actor_id": "LQQIXN9Othf8f7R5n"}'),

    ('perplexity', 'Perplexity AI', 'enrichment',
     'AI-powered research. Company research, news, competitive intelligence.',
     'api_key',
     '{"header_name": "Authorization", "prefix": "Bearer "}',
     '{"base_url": "https://api.perplexity.ai", "model": "llama-3.1-sonar-small-128k-online"}')

ON CONFLICT (name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    auth_config = EXCLUDED.auth_config,
    default_settings = EXCLUDED.default_settings;

-- ============================================================================
-- NEW TOOLS FOR ENRICHMENT
-- ============================================================================

INSERT INTO tool_library (name, display_name, description, category, input_schema, risk_level, requires_auth, auth_config_key)
VALUES
    ('enrich_person_pdl', 'Enrich Person (PDL)',
     'Look up person data via People Data Labs. Returns job title, company, LinkedIn URL, work email.',
     'enrichment',
     '{"type": "object", "properties": {"email": {"type": "string"}, "first_name": {"type": "string"}, "last_name": {"type": "string"}, "company": {"type": "string"}, "linkedin_url": {"type": "string"}}, "required": []}',
     'low', true, 'peopledatalabs'),

    ('find_email_hunter', 'Find Email (Hunter)',
     'Find professional email address using Hunter.io.',
     'enrichment',
     '{"type": "object", "properties": {"first_name": {"type": "string"}, "last_name": {"type": "string"}, "domain": {"type": "string"}}, "required": ["domain"]}',
     'low', true, 'hunter'),

    ('verify_email_hunter', 'Verify Email (Hunter)',
     'Verify if an email address is deliverable.',
     'enrichment',
     '{"type": "object", "properties": {"email": {"type": "string"}}, "required": ["email"]}',
     'low', true, 'hunter'),

    ('enrich_person_apollo', 'Enrich Person (Apollo)',
     'Look up person data via Apollo. Returns detailed professional info.',
     'enrichment',
     '{"type": "object", "properties": {"email": {"type": "string"}, "first_name": {"type": "string"}, "last_name": {"type": "string"}, "organization_name": {"type": "string"}}, "required": []}',
     'low', true, 'apollo_enrichment'),

    ('enrich_company_apollo', 'Enrich Company (Apollo)',
     'Look up company data via Apollo. Returns company size, industry, tech stack.',
     'enrichment',
     '{"type": "object", "properties": {"domain": {"type": "string"}, "name": {"type": "string"}}, "required": []}',
     'low', true, 'apollo_enrichment'),

    ('scrape_linkedin_profile', 'Scrape LinkedIn Profile',
     'Scrape a LinkedIn profile for detailed info using Apify.',
     'enrichment',
     '{"type": "object", "properties": {"linkedin_url": {"type": "string"}}, "required": ["linkedin_url"]}',
     'medium', true, 'apify'),

    ('research_company_perplexity', 'Research Company (Perplexity)',
     'AI-powered company research. Returns overview, news, competitive landscape.',
     'enrichment',
     '{"type": "object", "properties": {"company_name": {"type": "string"}, "domain": {"type": "string"}, "focus_areas": {"type": "array", "items": {"type": "string"}}}, "required": ["company_name"]}',
     'low', true, 'perplexity'),

    ('check_rate_limit', 'Check Rate Limit',
     'Check if we can make an API call without hitting rate limits.',
     'internal',
     '{"type": "object", "properties": {"integration_name": {"type": "string"}}, "required": ["integration_name"]}',
     'low', false, null),

    ('queue_enrichment', 'Queue Enrichment Job',
     'Add an enrichment job to the queue for async processing.',
     'internal',
     '{"type": "object", "properties": {"entity_type": {"type": "string"}, "entity_id": {"type": "string"}, "source": {"type": "string"}, "priority": {"type": "integer"}}, "required": ["entity_type", "entity_id", "source"]}',
     'low', false, null)

ON CONFLICT (name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema;

-- ============================================================================
-- NEW EVENT TYPES FOR ENRICHMENT
-- ============================================================================
-- These will be emitted by the enrichment process

-- No schema changes needed - events table already supports any event_type
-- Event types we'll use:
-- 'intake.new_lead' - New lead ready for SDR processing
-- 'intake.basic_lead' - Lead with minimal data, goes to scoring
-- 'intake.duplicate' - Duplicate found
-- 'intake.spam' - Spam detected
-- 'sdr.processed' - SDR finished enrichment
-- 'enrichment.failed' - Enrichment failed (for monitoring)
-- 'enrichment.partial' - Some enrichment succeeded, some failed

-- ============================================================================
-- HELPER FUNCTION: Check Rate Limit
-- ============================================================================

CREATE OR REPLACE FUNCTION check_rate_limit(
    p_team_id UUID,
    p_integration_name VARCHAR(100)
) RETURNS BOOLEAN AS $$
DECLARE
    v_limit RECORD;
    v_can_proceed BOOLEAN := true;
BEGIN
    -- Get or create rate limit record
    INSERT INTO api_rate_limits (team_id, integration_name)
    VALUES (p_team_id, p_integration_name)
    ON CONFLICT (team_id, integration_name) DO NOTHING;

    SELECT * INTO v_limit
    FROM api_rate_limits
    WHERE team_id = p_team_id AND integration_name = p_integration_name;

    -- Reset counters if needed
    IF v_limit.minute_reset_at < NOW() - INTERVAL '1 minute' THEN
        UPDATE api_rate_limits SET minute_count = 0, minute_reset_at = NOW()
        WHERE id = v_limit.id;
        v_limit.minute_count := 0;
    END IF;

    IF v_limit.hour_reset_at < NOW() - INTERVAL '1 hour' THEN
        UPDATE api_rate_limits SET hour_count = 0, hour_reset_at = NOW()
        WHERE id = v_limit.id;
        v_limit.hour_count := 0;
    END IF;

    IF v_limit.day_reset_at < NOW() - INTERVAL '1 day' THEN
        UPDATE api_rate_limits SET day_count = 0, day_reset_at = NOW()
        WHERE id = v_limit.id;
        v_limit.day_count := 0;
    END IF;

    -- Check limits
    IF v_limit.minute_count >= v_limit.requests_per_minute THEN
        v_can_proceed := false;
    ELSIF v_limit.hour_count >= v_limit.requests_per_hour THEN
        v_can_proceed := false;
    ELSIF v_limit.day_count >= v_limit.requests_per_day THEN
        v_can_proceed := false;
    END IF;

    RETURN v_can_proceed;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- HELPER FUNCTION: Increment Rate Limit Counter
-- ============================================================================

CREATE OR REPLACE FUNCTION increment_rate_limit(
    p_team_id UUID,
    p_integration_name VARCHAR(100),
    p_is_error BOOLEAN DEFAULT false
) RETURNS VOID AS $$
BEGIN
    UPDATE api_rate_limits SET
        minute_count = minute_count + 1,
        hour_count = hour_count + 1,
        day_count = day_count + 1,
        total_requests = total_requests + 1,
        total_errors = CASE WHEN p_is_error THEN total_errors + 1 ELSE total_errors END,
        last_request_at = NOW(),
        last_error_at = CASE WHEN p_is_error THEN NOW() ELSE last_error_at END,
        updated_at = NOW()
    WHERE team_id = p_team_id AND integration_name = p_integration_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER: Update timestamps
-- ============================================================================

CREATE TRIGGER product_context_updated_at
    BEFORE UPDATE ON product_context
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER api_rate_limits_updated_at
    BEFORE UPDATE ON api_rate_limits
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- VIEW: Enrichment Queue Status
-- ============================================================================

CREATE OR REPLACE VIEW enrichment_queue_status AS
SELECT
    source,
    status,
    COUNT(*) as count,
    AVG(attempts) as avg_attempts,
    MIN(created_at) as oldest,
    MAX(created_at) as newest
FROM enrichment_queue
GROUP BY source, status
ORDER BY source, status;

-- ============================================================================
-- VIEW: Rate Limit Status
-- ============================================================================

CREATE OR REPLACE VIEW rate_limit_status AS
SELECT
    integration_name,
    minute_count || '/' || requests_per_minute as minute_usage,
    hour_count || '/' || requests_per_hour as hour_usage,
    day_count || '/' || requests_per_day as day_usage,
    total_requests,
    total_errors,
    last_request_at,
    CASE
        WHEN minute_count >= requests_per_minute THEN 'MINUTE_LIMITED'
        WHEN hour_count >= requests_per_hour THEN 'HOUR_LIMITED'
        WHEN day_count >= requests_per_day THEN 'DAY_LIMITED'
        ELSE 'OK'
    END as status
FROM api_rate_limits
ORDER BY integration_name;
