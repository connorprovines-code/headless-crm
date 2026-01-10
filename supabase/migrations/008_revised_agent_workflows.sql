-- Migration 008: Revised Agent Workflows
-- Implements the 3-agent pipeline: Intake → SDR → Contact
-- SDR now includes scoring + tiered enrichment (merged from old Scoring agent)

-- ============================================================================
-- SCHEMA UPDATES
-- ============================================================================

-- Add work_email to contacts (separate from personal email)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS work_email TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS personal_email TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_tier TEXT CHECK (enrichment_tier IN ('none', 'light', 'deep'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_data JSONB DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS score_breakdown JSONB DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS flags TEXT[] DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sales_notes TEXT;

-- ============================================================================
-- DEACTIVATE OLD WORKFLOWS
-- ============================================================================

UPDATE workflow_templates SET is_active = false WHERE slug IN ('intake_agent', 'sdr_agent', 'scoring_agent', 'scoring_agent_basic', 'notification_agent');

-- ============================================================================
-- INTAKE AGENT v2
-- ============================================================================
-- Trigger: API call OR contact.created
-- Job: Extract → Spam Check → Dedupe → Route

INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system, version)
VALUES (
    'Intake Agent v2',
    'intake_agent_v2',
    'Gatekeeper: extracts all fields, checks spam, dedupes, routes to SDR (new) or Contact (existing)',
    'intake',
    'contact.created',
    true,
    2
) ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    trigger_event = EXCLUDED.trigger_event,
    version = EXCLUDED.version,
    is_active = true;

DO $$
DECLARE
    v_intake_id UUID;
    v_sdr_id UUID;
    v_contact_id UUID;
BEGIN
    SELECT id INTO v_intake_id FROM workflow_templates WHERE slug = 'intake_agent_v2';
    DELETE FROM workflow_steps WHERE workflow_template_id = v_intake_id;

    -- Step 1: Extract all fields from incoming data
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_intake_id, 'Extract All Fields', 'Parse and extract all available contact information from any format', 1, 'ai_prompt',
        '{"prompt_template": "Extract all contact information from this input. Be thorough - pull everything available.\n\nInput:\n{{event.payload}}\n\nExtract and return JSON with these fields (use null if not found):\n{\n  \"first_name\": string,\n  \"last_name\": string,\n  \"email\": string,\n  \"phone\": string,\n  \"company\": string,\n  \"title\": string,\n  \"linkedin_url\": string,\n  \"website\": string,\n  \"message\": string,\n  \"source\": string,\n  \"request_type\": string (sales|support|partnership|other),\n  \"additional_fields\": object\n}", "output_type": "json", "max_tokens": 500}',
        'extracted_data');

    -- Step 2: Spam detection
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_intake_id, 'Spam Detection', 'Check if contact appears to be spam', 2, 'ai_prompt',
        '{"prompt_template": "Analyze this contact for spam signals:\n\n{{extracted_data}}\n\nCheck for:\n- Gibberish names or emails\n- Known spam domains\n- Suspicious patterns\n- Bot-like behavior\n\nRespond with JSON:\n{\"is_spam\": boolean, \"confidence\": number 0-1, \"reason\": string}", "output_type": "json", "max_tokens": 150}',
        'spam_check');

    -- Step 3: Handle spam - delete and exit
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config)
    VALUES (v_intake_id, 'Handle Spam', 'Delete spam contacts', 3, 'condition_check',
        '{"condition": "{{spam_check.is_spam}} == true && {{spam_check.confidence}} > 0.7", "on_true": {"action": "delete_contact", "contact_id": "{{event.entity_id}}", "then": "emit_event", "event_type": "intake.spam_deleted", "finally": "stop"}, "on_false": {"action": "continue"}}');

    -- Step 4: Check for existing contact (dedupe)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_intake_id, 'Dedupe Check', 'Search for existing contact by email', 4, 'tool_call',
        '{"tool_name": "search_contacts", "input_mapping": {"email": "{{extracted_data.email}}", "exact_match": true, "exclude_id": "{{event.entity_id}}"}}',
        'existing_contact');

    -- Step 5a: If EXISTS - update and route to Contact Agent
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_intake_id, 'Update Existing Contact', 'Merge new data into existing contact', 5, 'tool_call',
        '{"tool_name": "merge_contact_data", "input_mapping": {"existing_contact_id": "{{existing_contact.id}}", "new_contact_id": "{{event.entity_id}}", "new_data": "{{extracted_data}}"}}',
        '[{"field": "{{existing_contact.count}}", "operator": ">", "value": 0}]');

    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_intake_id, 'Route Existing to Contact Agent', 'Send updated contact to Contact Agent', 6, 'tool_call',
        '{"tool_name": "emit_event", "input_mapping": {"event_type": "intake.existing_updated", "entity_type": "contact", "entity_id": "{{existing_contact.id}}", "payload": {"source": "intake", "request_type": "{{extracted_data.request_type}}", "message": "{{extracted_data.message}}"}}}',
        '[{"field": "{{existing_contact.count}}", "operator": ">", "value": 0}]');

    -- Step 5b: If NEW - update contact with extracted data and route to SDR
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_intake_id, 'Save New Contact', 'Store extracted data on new contact', 7, 'tool_call',
        '{"tool_name": "update_contact", "input_mapping": {"contact_id": "{{event.entity_id}}", "first_name": "{{extracted_data.first_name}}", "last_name": "{{extracted_data.last_name}}", "email": "{{extracted_data.email}}", "phone": "{{extracted_data.phone}}", "title": "{{extracted_data.title}}", "linkedin_url": "{{extracted_data.linkedin_url}}"}}',
        '[{"field": "{{existing_contact.count}}", "operator": "==", "value": 0}]');

    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_intake_id, 'Route New to SDR Agent', 'Send new contact to SDR Agent for enrichment', 8, 'tool_call',
        '{"tool_name": "emit_event", "input_mapping": {"event_type": "intake.new_contact", "entity_type": "contact", "entity_id": "{{event.entity_id}}", "payload": {"source": "intake", "extracted_data": "{{extracted_data}}"}}}',
        '[{"field": "{{existing_contact.count}}", "operator": "==", "value": 0}]');

    -- ============================================================================
    -- SDR AGENT v2 (includes scoring + tiered enrichment)
    -- ============================================================================

    INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system, version)
    VALUES (
        'SDR Agent v2',
        'sdr_agent_v2',
        'Researcher + Scorer: ensures work email, scores lead, enriches based on tier, deep analysis for high-value, routes to Contact Agent',
        'enrichment',
        'intake.new_contact',
        true,
        2
    ) ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        trigger_event = EXCLUDED.trigger_event,
        version = EXCLUDED.version,
        is_active = true;

    SELECT id INTO v_sdr_id FROM workflow_templates WHERE slug = 'sdr_agent_v2';
    DELETE FROM workflow_steps WHERE workflow_template_id = v_sdr_id;

    -- Step 1: Load contact data
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Load Contact', 'Get current contact data', 1, 'tool_call',
        '{"tool_name": "get_contact", "input_mapping": {"contact_id": "{{event.entity_id}}"}}',
        'contact');

    -- Step 2: Check if email is business email
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Check Email Type', 'Determine if email is business or personal', 2, 'tool_call',
        '{"tool_name": "classify_email", "input_mapping": {"email": "{{contact.email}}"}}',
        'email_type');

    -- Step 3: If personal email, run PDL to get work email
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error, run_conditions)
    VALUES (v_sdr_id, 'PDL Enrichment', 'Get work email and additional data from PDL', 3, 'tool_call',
        '{"tool_name": "enrich_person_pdl", "input_mapping": {"email": "{{contact.email}}", "first_name": "{{contact.first_name}}", "last_name": "{{contact.last_name}}", "linkedin_url": "{{contact.linkedin_url}}"}}',
        'pdl_data', 'continue',
        '[{"field": "{{email_type.is_personal}}", "operator": "==", "value": true}]');

    -- Step 4: Update contact with PDL data if found
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_sdr_id, 'Update from PDL', 'Store PDL enrichment data', 4, 'tool_call',
        '{"tool_name": "update_contact", "input_mapping": {"contact_id": "{{contact.id}}", "work_email": "{{pdl_data.data.work_email}}", "personal_email": "{{contact.email}}", "title": "{{pdl_data.data.title}}", "linkedin_url": "{{pdl_data.data.linkedin_url}}", "phone": "{{pdl_data.data.phone}}"}}',
        '[{"field": "{{pdl_data.success}}", "operator": "==", "value": true}]');

    -- Step 5: Reload contact with updated data
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Reload Contact', 'Get updated contact data', 5, 'tool_call',
        '{"tool_name": "get_contact", "input_mapping": {"contact_id": "{{event.entity_id}}"}}',
        'contact');

    -- Step 6: Initial scoring (0-10)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Initial Score', 'Calculate initial lead score based on available data', 6, 'ai_prompt',
        '{"prompt_template": "Score this lead from 0-10 based on available information.\n\n**Contact:**\nName: {{contact.first_name}} {{contact.last_name}}\nEmail: {{contact.work_email || contact.email}}\nTitle: {{contact.title}}\nCompany: {{contact.company_name}}\nLinkedIn: {{contact.linkedin_url}}\n\n**Scoring Criteria:**\n- Title seniority (C-level, VP, Director = high)\n- Business email vs personal\n- Company domain (enterprise = higher)\n- Role relevance\n- Data completeness\n\nRespond with JSON:\n{\"score\": <0-10>, \"breakdown\": {\"title_seniority\": <0-3>, \"email_quality\": <0-2>, \"company_signal\": <0-3>, \"data_quality\": <0-2>}, \"reasons\": [<string>], \"enrichment_tier\": \"deep|light|none\"}\n\nTiers: 7-10=deep, 5-6=light, 0-4=none", "output_type": "json", "max_tokens": 300}',
        'initial_score');

    -- Step 7: Save initial score
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config)
    VALUES (v_sdr_id, 'Save Initial Score', 'Store initial score on contact', 7, 'tool_call',
        '{"tool_name": "update_contact", "input_mapping": {"contact_id": "{{contact.id}}", "score": "{{initial_score.score}}", "score_breakdown": "{{initial_score.breakdown}}", "enrichment_tier": "{{initial_score.enrichment_tier}}"}}');

    -- Step 8: Extract domain for company lookup
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, run_conditions)
    VALUES (v_sdr_id, 'Extract Domain', 'Get company domain from email', 8, 'tool_call',
        '{"tool_name": "extract_domain", "input_mapping": {"email": "{{contact.work_email || contact.email}}"}}',
        'domain_info',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "in", "value": ["deep", "light"]}]');

    -- TIER: LIGHT + DEEP - Hunter verify
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error, run_conditions)
    VALUES (v_sdr_id, 'Hunter Verify', 'Verify email deliverability', 9, 'tool_call',
        '{"tool_name": "verify_email_hunter", "input_mapping": {"email": "{{contact.work_email || contact.email}}"}}',
        'hunter_verify', 'continue',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "in", "value": ["deep", "light"]}]');

    -- TIER: LIGHT + DEEP - Perplexity (depth varies)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error, run_conditions)
    VALUES (v_sdr_id, 'Perplexity Research', 'Company research (depth based on tier)', 10, 'tool_call',
        '{"tool_name": "research_company_perplexity", "input_mapping": {"company_name": "{{contact.company_name || domain_info.company_name}}", "domain": "{{domain_info.domain}}", "depth": "{{initial_score.enrichment_tier}}"}}',
        'perplexity_data', 'continue',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "in", "value": ["deep", "light"]}]');

    -- TIER: DEEP ONLY - LinkedIn
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error, run_conditions)
    VALUES (v_sdr_id, 'LinkedIn Scrape', 'Get LinkedIn posts and profile data (max 10 posts)', 11, 'tool_call',
        '{"tool_name": "scrape_linkedin_profile", "input_mapping": {"linkedin_url": "{{contact.linkedin_url}}", "limit": 10}}',
        'linkedin_data', 'continue',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "==", "value": "deep"}, {"field": "{{contact.linkedin_url}}", "operator": "is_not_empty"}]');

    -- TIER: DEEP ONLY - Apollo (when enabled)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error, run_conditions)
    VALUES (v_sdr_id, 'Apollo Enrich', 'Additional person/company data from Apollo (when enabled)', 12, 'tool_call',
        '{"tool_name": "enrich_person_apollo", "input_mapping": {"email": "{{contact.work_email || contact.email}}", "first_name": "{{contact.first_name}}", "last_name": "{{contact.last_name}}", "domain": "{{domain_info.domain}}"}}',
        'apollo_data', 'continue',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "==", "value": "deep"}]');

    -- Store all enrichment data
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_sdr_id, 'Store Enrichment Data', 'Save all enrichment results to contact', 13, 'tool_call',
        '{"tool_name": "update_contact", "input_mapping": {"contact_id": "{{contact.id}}", "enrichment_data": {"hunter": "{{hunter_verify}}", "perplexity": "{{perplexity_data}}", "linkedin": "{{linkedin_data}}", "apollo": "{{apollo_data}}", "enriched_at": "{{now()}}"}}}',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "in", "value": ["deep", "light"]}]');

    -- DEEP ANALYSIS (7+ only)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, run_conditions)
    VALUES (v_sdr_id, 'Deep Analysis', 'Synthesize all data, generate insights for high-value leads', 14, 'ai_prompt',
        '{"prompt_template": "You are analyzing a high-value lead. Synthesize all available data and provide actionable intelligence.\n\n**Contact:**\n{{contact}}\n\n**LinkedIn Data:**\n{{linkedin_data}}\n\n**Company Research:**\n{{perplexity_data}}\n\n**Apollo Data:**\n{{apollo_data}}\n\n**Hunter Verification:**\n{{hunter_verify}}\n\nProvide:\n1. **Executive Summary** (2-3 sentences)\n2. **Key Talking Points** (3-5 bullets)\n3. **Pain Points** (likely challenges)\n4. **Flags** (array: decision_maker, budget_holder, technical, recent_funding, hiring, competitor_user, etc.)\n5. **Recommended Approach**\n6. **Risk Factors**\n\nRespond with JSON:\n{\"summary\": string, \"talking_points\": [string], \"pain_points\": [string], \"flags\": [string], \"recommended_approach\": string, \"risk_factors\": [string], \"sales_notes\": string}", "output_type": "json", "max_tokens": 800}',
        'deep_analysis',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "==", "value": "deep"}]');

    -- Store deep analysis
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_sdr_id, 'Store Analysis', 'Save deep analysis to contact', 15, 'tool_call',
        '{"tool_name": "update_contact", "input_mapping": {"contact_id": "{{contact.id}}", "flags": "{{deep_analysis.flags}}", "sales_notes": "{{deep_analysis.sales_notes}}", "notes": "{{deep_analysis.summary}}"}}',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "==", "value": "deep"}]');

    -- Re-score after deep enrichment
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, run_conditions)
    VALUES (v_sdr_id, 'Re-Score', 'Update score based on enrichment findings', 16, 'ai_prompt',
        '{"prompt_template": "Re-evaluate this lead score based on enrichment data.\n\n**Initial Score:** {{initial_score.score}}/10\n**Initial Reasons:** {{initial_score.reasons}}\n\n**New Information:**\n- Deep Analysis: {{deep_analysis}}\n- Email Valid: {{hunter_verify.data.status}}\n- LinkedIn Activity: {{linkedin_data.data.posts.length || 0}} posts\n\n**Adjustments:**\n+1-2 for: decision maker confirmed, recent activity, strong company fit, budget signals\n-1-2 for: invalid email, no engagement, mismatched role, risk factors\n\nRespond with JSON:\n{\"new_score\": <0-10>, \"score_change\": <number>, \"adjustment_reasons\": [string]}", "output_type": "json", "max_tokens": 200}',
        'rescore',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "==", "value": "deep"}]');

    -- Update final score
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_sdr_id, 'Update Final Score', 'Store re-scored value', 17, 'tool_call',
        '{"tool_name": "update_contact", "input_mapping": {"contact_id": "{{contact.id}}", "score": "{{rescore.new_score}}", "score_breakdown": {"initial": "{{initial_score.breakdown}}", "adjustments": "{{rescore.adjustment_reasons}}"}}}',
        '[{"field": "{{initial_score.enrichment_tier}}", "operator": "==", "value": "deep"}]');

    -- Route to Contact Agent
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config)
    VALUES (v_sdr_id, 'Route to Contact Agent', 'Hand off to Contact Agent for notification/routing', 18, 'tool_call',
        '{"tool_name": "emit_event", "input_mapping": {"event_type": "sdr.complete", "entity_type": "contact", "entity_id": "{{contact.id}}", "payload": {"score": "{{rescore.new_score || initial_score.score}}", "enrichment_tier": "{{initial_score.enrichment_tier}}", "flags": "{{deep_analysis.flags || []}}", "source": "sdr_agent"}}}');

    -- ============================================================================
    -- CONTACT AGENT (Placeholder)
    -- ============================================================================

    INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system, version)
    VALUES (
        'Contact Agent',
        'contact_agent',
        'Notification router: alerts sales for hot leads, routes support requests, manages follow-ups',
        'notification',
        'sdr.complete',
        true,
        1
    ) ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        trigger_event = EXCLUDED.trigger_event,
        version = EXCLUDED.version,
        is_active = true;

    SELECT id INTO v_contact_id FROM workflow_templates WHERE slug = 'contact_agent';
    DELETE FROM workflow_steps WHERE workflow_template_id = v_contact_id;

    -- Load contact
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_contact_id, 'Load Contact', 'Get contact details', 1, 'tool_call',
        '{"tool_name": "get_contact_brief", "input_mapping": {"contact_id": "{{event.entity_id}}"}}',
        'contact_brief');

    -- Hot lead alert (score >= 8)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_contact_id, 'Hot Lead Alert', 'Notify sales of high-value lead', 2, 'tool_call',
        '{"tool_name": "send_notification", "input_mapping": {"channel": "slack", "template": "hot_lead", "data": {"contact_name": "{{contact_brief.contact.first_name}} {{contact_brief.contact.last_name}}", "company": "{{contact_brief.contact.company_name}}", "title": "{{contact_brief.contact.title}}", "score": "{{event.payload.score}}", "flags": "{{event.payload.flags}}", "summary": "{{contact_brief.contact.notes}}"}}}',
        '[{"field": "{{event.payload.score}}", "operator": ">=", "value": 8}]');

    -- Warm lead alert (score 6-7)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_contact_id, 'Warm Lead Alert', 'Queue warm lead for follow-up', 3, 'tool_call',
        '{"tool_name": "send_notification", "input_mapping": {"channel": "slack", "template": "warm_lead", "data": {"contact_name": "{{contact_brief.contact.first_name}} {{contact_brief.contact.last_name}}", "company": "{{contact_brief.contact.company_name}}", "score": "{{event.payload.score}}"}}}',
        '[{"field": "{{event.payload.score}}", "operator": ">=", "value": 6}, {"field": "{{event.payload.score}}", "operator": "<", "value": 8}]');

    -- Create follow-up task for hot leads
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_contact_id, 'Create Follow-up Task', 'Schedule immediate follow-up for hot leads', 4, 'tool_call',
        '{"tool_name": "create_task", "input_mapping": {"contact_id": "{{contact_brief.contact.id}}", "type": "call", "priority": 1, "reason": "Hot lead - Score: {{event.payload.score}}", "due_date": "today"}}',
        '[{"field": "{{event.payload.score}}", "operator": ">=", "value": 8}]');

END $$;

-- ============================================================================
-- ADDITIONAL TRIGGER: Contact Agent for existing contact updates
-- ============================================================================

INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system, version)
VALUES (
    'Contact Agent (Existing Update)',
    'contact_agent_existing',
    'Contact Agent triggered when intake updates an existing contact (for support routing, etc.)',
    'notification',
    'intake.existing_updated',
    true,
    1
) ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- HELPER VIEW: Active Workflows v2
-- ============================================================================

-- Drop and recreate view to change column order
DROP VIEW IF EXISTS active_workflows;

CREATE VIEW active_workflows AS
SELECT
    wt.id,
    wt.name,
    wt.slug,
    wt.trigger_event,
    wt.category,
    wt.version,
    COUNT(ws.id) as step_count,
    wt.is_active,
    wt.created_at
FROM workflow_templates wt
LEFT JOIN workflow_steps ws ON ws.workflow_template_id = wt.id AND ws.is_enabled = true
WHERE wt.is_active = true
GROUP BY wt.id
ORDER BY wt.category, wt.name;

-- ============================================================================
-- SUMMARY
-- ============================================================================
--
-- New 3-Agent Pipeline:
--
-- 1. INTAKE AGENT v2
--    - Extracts all fields from any input format
--    - Spam detection + deletion
--    - Dedupe check
--    - Routes: NEW → SDR Agent, EXISTS → Contact Agent
--
-- 2. SDR AGENT v2 (merged with Scoring)
--    - Ensures work email (PDL if needed)
--    - Initial score 0-10
--    - Tiered enrichment:
--      * 7-10 (deep): Hunter + Perplexity deep + LinkedIn + Apollo
--      * 5-6 (light): Hunter + Perplexity light
--      * 0-4 (none): Skip enrichment
--    - Deep analysis loop for 7+ (synthesize, notes, flags, re-score)
--    - Routes to Contact Agent
--
-- 3. CONTACT AGENT (placeholder)
--    - Hot lead alerts (8+)
--    - Warm lead alerts (6-7)
--    - Task creation for follow-up
--    - Future: support routing, etc.
