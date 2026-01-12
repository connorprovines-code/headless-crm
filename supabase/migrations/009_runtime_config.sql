-- Migration 009: Runtime Configuration Tables
-- Enables dynamic agent behavior modification via CLI

-- ============================================================================
-- INTAKE SOURCES (Dynamic intake configuration)
-- ============================================================================
-- The Intake Agent reads from this table to know how to process different sources

CREATE TABLE IF NOT EXISTS intake_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

  -- Source identification
  name TEXT NOT NULL,                    -- "Typeform Leads", "LinkedIn Webhook", "Manual Entry"
  slug TEXT NOT NULL,                    -- "typeform_leads", "linkedin_webhook", "manual"
  source_type TEXT NOT NULL,             -- "webhook", "api_poll", "manual", "email", "form"

  -- Webhook/API configuration
  webhook_secret TEXT,                   -- For validating incoming webhooks
  api_endpoint TEXT,                     -- For polling sources
  api_credentials JSONB,                 -- Encrypted API keys/tokens
  poll_interval_minutes INTEGER,         -- For api_poll type

  -- Field mapping: how to extract contact data from the source payload
  -- e.g., {"email": "$.data.email", "first_name": "$.data.name.first"}
  field_mapping JSONB NOT NULL DEFAULT '{}',

  -- Processing rules
  auto_enrich BOOLEAN DEFAULT true,      -- Whether to trigger enrichment pipeline
  default_score INTEGER DEFAULT 5,       -- Starting score for contacts from this source
  default_tags TEXT[],                   -- Tags to apply automatically

  -- Validation rules (optional)
  required_fields TEXT[],                -- Fields that must be present
  validation_rules JSONB,                -- Custom validation (e.g., email format)

  -- Status
  is_enabled BOOLEAN DEFAULT true,
  last_received_at TIMESTAMPTZ,
  total_contacts INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(team_id, slug)
);

-- Index for webhook lookups
CREATE INDEX idx_intake_sources_webhook ON intake_sources(webhook_secret) WHERE webhook_secret IS NOT NULL;
CREATE INDEX idx_intake_sources_enabled ON intake_sources(team_id, is_enabled) WHERE is_enabled = true;

-- ============================================================================
-- TEAM CONFIGURATION (ICP, Scoring, Preferences)
-- ============================================================================
-- Central config that agents read for dynamic behavior

CREATE TABLE IF NOT EXISTS team_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

  -- Config identification
  config_key TEXT NOT NULL,              -- "icp", "scoring_rules", "enrichment_settings"
  config_value JSONB NOT NULL,           -- The actual configuration

  -- Metadata
  description TEXT,                      -- Human-readable description
  last_modified_by TEXT,                 -- "cli", "dashboard", "user:uuid"

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(team_id, config_key)
);

-- ============================================================================
-- INSERT DEFAULT CONFIGURATIONS
-- ============================================================================

-- Default ICP definition (read by SDR Agent scoring)
INSERT INTO team_config (team_id, config_key, config_value, description) VALUES
(NULL, 'icp', '{
  "title_keywords": {
    "high_value": ["CEO", "CTO", "CFO", "COO", "Founder", "Co-Founder", "President", "Owner"],
    "medium_value": ["VP", "Vice President", "Director", "Head of"],
    "low_value": ["Manager", "Lead", "Senior"]
  },
  "company_size": {
    "ideal_min": 50,
    "ideal_max": 500,
    "acceptable_min": 10,
    "acceptable_max": 2000
  },
  "industries": {
    "preferred": ["Technology", "Software", "SaaS", "FinTech", "HealthTech"],
    "acceptable": ["Professional Services", "Consulting", "E-commerce"],
    "excluded": ["Government", "Education", "Non-profit"]
  },
  "signals": {
    "positive": ["recent_funding", "hiring", "expansion", "new_product"],
    "negative": ["layoffs", "restructuring", "competitor_user"]
  },
  "description": "Default ICP: Tech companies 50-500 employees, decision makers"
}', 'Ideal Customer Profile - defines target customer characteristics for scoring')
ON CONFLICT (team_id, config_key) DO NOTHING;

-- Default scoring rules (read by SDR Agent)
INSERT INTO team_config (team_id, config_key, config_value, description) VALUES
(NULL, 'scoring_rules', '{
  "base_score": 5,
  "title_score": {
    "high_value": 3,
    "medium_value": 2,
    "low_value": 1
  },
  "email_score": {
    "work_email_verified": 2,
    "work_email_unverified": 1,
    "personal_email": 0
  },
  "company_score": {
    "ideal_size": 2,
    "acceptable_size": 1,
    "preferred_industry": 1
  },
  "enrichment_thresholds": {
    "deep": 7,
    "light": 5,
    "none": 0
  },
  "hot_lead_threshold": 8,
  "warm_lead_threshold": 6
}', 'Scoring rules - defines how lead scores are calculated')
ON CONFLICT (team_id, config_key) DO NOTHING;

-- Default enrichment settings
INSERT INTO team_config (team_id, config_key, config_value, description) VALUES
(NULL, 'enrichment_settings', '{
  "auto_enrich_new_contacts": true,
  "enrichment_providers": {
    "email_finder": "generect",
    "company_research": "perplexity",
    "linkedin_scraping": "apify",
    "person_enrichment": "pdl"
  },
  "cost_limits": {
    "max_per_contact_cents": 15,
    "max_daily_spend_cents": 500
  },
  "skip_enrichment_for": {
    "domains": ["gmail.com", "yahoo.com", "hotmail.com"],
    "score_below": 3
  }
}', 'Enrichment settings - controls which APIs to use and cost limits')
ON CONFLICT (team_id, config_key) DO NOTHING;

-- ============================================================================
-- HELPER FUNCTION: Get config with fallback to global default
-- ============================================================================

CREATE OR REPLACE FUNCTION get_team_config(p_team_id UUID, p_config_key TEXT)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  -- Try team-specific config first
  SELECT config_value INTO result
  FROM team_config
  WHERE team_id = p_team_id AND config_key = p_config_key;

  -- Fall back to global default (team_id IS NULL)
  IF result IS NULL THEN
    SELECT config_value INTO result
    FROM team_config
    WHERE team_id IS NULL AND config_key = p_config_key;
  END IF;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- AUDIT: Track config changes
-- ============================================================================

CREATE TABLE IF NOT EXISTS config_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  config_key TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  changed_by TEXT,                       -- "cli", "api", "user:uuid"
  change_reason TEXT,                    -- Natural language reason
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger to log config changes
CREATE OR REPLACE FUNCTION log_config_change()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO config_audit_log (team_id, config_key, old_value, new_value, changed_by)
  VALUES (
    COALESCE(NEW.team_id, OLD.team_id),
    COALESCE(NEW.config_key, OLD.config_key),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.config_value END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.config_value END,
    COALESCE(NEW.last_modified_by, 'system')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER team_config_audit
AFTER INSERT OR UPDATE OR DELETE ON team_config
FOR EACH ROW EXECUTE FUNCTION log_config_change();

-- ============================================================================
-- RLS POLICIES
-- ============================================================================
-- Note: Using 'users' table (not 'team_members') to match existing schema

ALTER TABLE intake_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_audit_log ENABLE ROW LEVEL SECURITY;

-- Intake sources: team members can view/edit their team's sources
CREATE POLICY intake_sources_team_access ON intake_sources
  FOR ALL USING (
    team_id IS NULL OR  -- Global defaults readable by all
    team_id IN (SELECT team_id FROM users WHERE id = auth.uid())
  );

-- Team config: team members can view/edit their team's config
CREATE POLICY team_config_team_access ON team_config
  FOR ALL USING (
    team_id IS NULL OR  -- Global defaults readable by all
    team_id IN (SELECT team_id FROM users WHERE id = auth.uid())
  );

-- Audit log: read-only for team members
CREATE POLICY config_audit_team_read ON config_audit_log
  FOR SELECT USING (
    team_id IS NULL OR
    team_id IN (SELECT team_id FROM users WHERE id = auth.uid())
  );
