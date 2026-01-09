-- Migration 007: Define Agent Workflows
-- Populates workflow_templates and workflow_steps for the 4-agent pipeline

-- ============================================================================
-- INTAKE AGENT WORKFLOW
-- ============================================================================
-- Trigger: contact.created
-- Job: Gatekeeper - classify, dedupe, route

INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system)
VALUES (
    'Intake Agent',
    'intake_agent',
    'Gatekeeper agent: normalizes data, checks duplicates, detects spam, routes to SDR or Scoring based on email type',
    'enrichment',
    'contact.created',
    true
) ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    trigger_event = EXCLUDED.trigger_event;

-- Get the workflow ID for steps
DO $$
DECLARE
    v_intake_id UUID;
    v_sdr_id UUID;
    v_scoring_id UUID;
    v_notification_id UUID;
BEGIN
    SELECT id INTO v_intake_id FROM workflow_templates WHERE slug = 'intake_agent';

    -- Clear existing steps for this workflow
    DELETE FROM workflow_steps WHERE workflow_template_id = v_intake_id;

    -- Step 1: Extract & normalize data
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_intake_id, 'Normalize Contact Data', 'Extract and normalize incoming contact data', 1, 'tool_call',
        '{"tool_name": "normalize_contact", "input_mapping": {"contact_id": "{{event.entity_id}}"}}',
        'normalized_contact');

    -- Step 2: Duplicate check
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error)
    VALUES (v_intake_id, 'Check for Duplicates', 'Search for existing contact with same email', 2, 'tool_call',
        '{"tool_name": "search_contacts", "input_mapping": {"email": "{{normalized_contact.email}}", "exact_match": true}}',
        'duplicate_check', 'continue');

    -- Step 3: Branch on duplicate
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config)
    VALUES (v_intake_id, 'Handle Duplicate', 'If duplicate found, merge and exit', 3, 'condition_check',
        '{"condition": "{{duplicate_check.count}} > 0", "on_true": {"action": "emit_event", "event_type": "intake.duplicate", "then": "stop"}, "on_false": {"action": "continue"}}');

    -- Step 4: Spam check
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_intake_id, 'Spam Detection', 'Check if contact appears to be spam', 4, 'ai_prompt',
        '{"prompt_template": "Analyze this contact and determine if it appears to be spam or a legitimate lead. Contact: {{normalized_contact}}. Respond with JSON: {\"is_spam\": boolean, \"confidence\": number, \"reason\": string}", "output_type": "json"}',
        'spam_check');

    -- Step 5: Branch on spam
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config)
    VALUES (v_intake_id, 'Handle Spam', 'If spam detected with high confidence, delete and exit', 5, 'condition_check',
        '{"condition": "{{spam_check.is_spam}} == true && {{spam_check.confidence}} > 0.8", "on_true": {"action": "delete_contact", "then": "emit_event", "event_type": "intake.spam", "then": "stop"}, "on_false": {"action": "continue"}}');

    -- Step 6: Check email type (personal vs company)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_intake_id, 'Classify Email Type', 'Determine if email is personal or company domain', 6, 'tool_call',
        '{"tool_name": "classify_email", "input_mapping": {"email": "{{normalized_contact.email}}"}}',
        'email_type');

    -- Step 7: Branch on email type - Personal email path
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions, output_variable, on_error)
    VALUES (v_intake_id, 'PDL Lookup (Personal Email)', 'For personal emails, try to find work email via PDL', 7, 'tool_call',
        '{"tool_name": "enrich_person_pdl", "input_mapping": {"email": "{{normalized_contact.email}}", "first_name": "{{normalized_contact.first_name}}", "last_name": "{{normalized_contact.last_name}}"}}',
        '[{"field": "{{email_type.is_personal}}", "operator": "equals", "value": true}]',
        'pdl_result', 'continue');

    -- Step 8: Route based on PDL result
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_intake_id, 'Route Personal Email Lead', 'Route to SDR if work email found, else to Scoring', 8, 'branch',
        '{"branches": [{"condition": "{{pdl_result.work_email}} != null", "action": "update_contact", "updates": {"work_email": "{{pdl_result.work_email}}", "linkedin_url": "{{pdl_result.linkedin_url}}"}, "then": "emit_event", "event_type": "intake.new_lead"}, {"condition": "{{pdl_result.work_email}} == null", "action": "emit_event", "event_type": "intake.basic_lead"}]}',
        '[{"field": "{{email_type.is_personal}}", "operator": "equals", "value": true}]');

    -- Step 9: Route company email directly to SDR
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_intake_id, 'Route Company Email Lead', 'Company emails go directly to SDR agent', 9, 'tool_call',
        '{"tool_name": "emit_event", "input_mapping": {"event_type": "intake.new_lead", "entity_type": "contact", "entity_id": "{{event.entity_id}}", "payload": {"source": "intake", "email_type": "company"}}}',
        '[{"field": "{{email_type.is_personal}}", "operator": "equals", "value": false}]');

    -- ============================================================================
    -- SDR AGENT WORKFLOW
    -- ============================================================================
    -- Trigger: intake.new_lead
    -- Job: Researcher - enrich, synthesize, generate insight

    INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system)
    VALUES (
        'SDR Agent',
        'sdr_agent',
        'Researcher agent: enriches contacts via Hunter/Apollo/Apify/Perplexity, synthesizes data, generates insights',
        'enrichment',
        'intake.new_lead',
        true
    ) ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        trigger_event = EXCLUDED.trigger_event;

    SELECT id INTO v_sdr_id FROM workflow_templates WHERE slug = 'sdr_agent';

    -- Clear existing steps
    DELETE FROM workflow_steps WHERE workflow_template_id = v_sdr_id;

    -- Step 1: Load contact data
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Load Contact', 'Fetch full contact record', 1, 'tool_call',
        '{"tool_name": "get_contact", "input_mapping": {"contact_id": "{{event.entity_id}}"}}',
        'contact');

    -- Step 2: Extract company domain
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Extract Domain', 'Get company domain from email', 2, 'tool_call',
        '{"tool_name": "extract_domain", "input_mapping": {"email": "{{contact.email}}"}}',
        'domain_info');

    -- Step 3: Hunter.io email verification (parallel start)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error)
    VALUES (v_sdr_id, 'Verify Email (Hunter)', 'Verify email deliverability', 3, 'tool_call',
        '{"tool_name": "verify_email_hunter", "input_mapping": {"email": "{{contact.email}}"}, "parallel_group": "enrichment_batch_1"}',
        'hunter_verify', 'continue');

    -- Step 4: Apollo person enrichment (parallel)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error)
    VALUES (v_sdr_id, 'Enrich Person (Apollo)', 'Get job title, company info from Apollo', 4, 'tool_call',
        '{"tool_name": "enrich_person_apollo", "input_mapping": {"email": "{{contact.email}}", "first_name": "{{contact.first_name}}", "last_name": "{{contact.last_name}}"}, "parallel_group": "enrichment_batch_1"}',
        'apollo_person', 'continue');

    -- Step 5: Apollo company enrichment (parallel)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error)
    VALUES (v_sdr_id, 'Enrich Company (Apollo)', 'Get company size, industry, tech stack', 5, 'tool_call',
        '{"tool_name": "enrich_company_apollo", "input_mapping": {"domain": "{{domain_info.domain}}"}, "parallel_group": "enrichment_batch_1"}',
        'apollo_company', 'continue');

    -- Step 6: LinkedIn scrape via Apify (uses linkedin_url from PDL or Apollo)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error, run_conditions)
    VALUES (v_sdr_id, 'Scrape LinkedIn Profile', 'Get detailed profile info from LinkedIn via Apify', 6, 'tool_call',
        '{"tool_name": "scrape_linkedin_profile", "input_mapping": {"linkedin_url": "{{contact.linkedin_url}}"}}',
        'linkedin_data', 'continue',
        '[{"field": "{{contact.linkedin_url}}", "operator": "is_not_empty"}]');

    -- Step 7: Perplexity company research
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable, on_error)
    VALUES (v_sdr_id, 'Research Company (Perplexity)', 'AI-powered company research, news, competitive landscape', 7, 'tool_call',
        '{"tool_name": "research_company_perplexity", "input_mapping": {"company_name": "{{apollo_company.name}}", "domain": "{{domain_info.domain}}", "focus_areas": ["recent_news", "competitors", "key_initiatives"]}}',
        'perplexity_research', 'continue');

    -- Step 8: Update contact with enrichment data
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Update Contact Record', 'Store all enrichment data on contact', 8, 'tool_call',
        '{"tool_name": "update_contact", "input_mapping": {"contact_id": "{{contact.id}}", "title": "{{apollo_person.title}}", "linkedin_url": "{{apollo_person.linkedin_url}}", "enrichment_status": "complete", "enrichment_data": {"hunter": "{{hunter_verify}}", "apollo_person": "{{apollo_person}}", "apollo_company": "{{apollo_company}}", "linkedin": "{{linkedin_data}}", "perplexity": "{{perplexity_research}}"}}}',
        'updated_contact');

    -- Step 9: Create/update company record
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Upsert Company', 'Create or update company with enrichment data', 9, 'tool_call',
        '{"tool_name": "upsert_company", "input_mapping": {"domain": "{{domain_info.domain}}", "name": "{{apollo_company.name}}", "industry": "{{apollo_company.industry}}", "employee_count": "{{apollo_company.employee_count}}", "enrichment_data": {"apollo": "{{apollo_company}}", "perplexity": "{{perplexity_research}}"}}}',
        'company');

    -- Step 10: Link contact to company
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config)
    VALUES (v_sdr_id, 'Link Contact to Company', 'Associate contact with company record', 10, 'tool_call',
        '{"tool_name": "update_contact", "input_mapping": {"contact_id": "{{contact.id}}", "company_id": "{{company.id}}"}}');

    -- Step 11: Load product context for insight generation
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Load Product Context', 'Get product info for personalized insight', 11, 'tool_call',
        '{"tool_name": "get_product_context", "input_mapping": {"is_default": true}}',
        'product_context');

    -- Step 12: Generate AI insight
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_sdr_id, 'Generate Insight', 'AI synthesizes data and generates actionable insight', 12, 'ai_prompt',
        '{"prompt_template": "You are an SDR assistant. Analyze this lead and generate a brief, actionable insight.\n\n**Contact:**\n{{updated_contact}}\n\n**Company:**\n{{company}}\n\n**LinkedIn:**\n{{linkedin_data}}\n\n**Company Research:**\n{{perplexity_research}}\n\n**Our Product:**\n{{product_context}}\n\nProvide:\n1. One-sentence summary of why this lead is relevant\n2. Suggested talking points (2-3 bullets)\n3. Potential pain points we can address\n4. Recommended next action\n\nKeep it concise and actionable.", "output_type": "text", "max_tokens": 500}',
        'insight');

    -- Step 13: Store insight
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config)
    VALUES (v_sdr_id, 'Store Insight', 'Save generated insight to contact notes', 13, 'tool_call',
        '{"tool_name": "add_contact_note", "input_mapping": {"contact_id": "{{contact.id}}", "note": "{{insight}}", "note_type": "sdr_insight"}}');

    -- Step 14: Emit completion event
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config)
    VALUES (v_sdr_id, 'Emit SDR Processed', 'Signal completion to trigger Scoring agent', 14, 'tool_call',
        '{"tool_name": "emit_event", "input_mapping": {"event_type": "sdr.processed", "entity_type": "contact", "entity_id": "{{contact.id}}", "payload": {"company_id": "{{company.id}}", "enrichment_status": "complete"}}}');

    -- ============================================================================
    -- SCORING AGENT WORKFLOW
    -- ============================================================================
    -- Trigger: sdr.processed, intake.basic_lead, interaction.logged
    -- Job: Evaluator - calculate/recalculate lead scores

    INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system)
    VALUES (
        'Scoring Agent',
        'scoring_agent',
        'Evaluator agent: calculates lead scores based on enrichment data, interactions, and ICP fit',
        'scoring',
        'sdr.processed',
        true
    ) ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        trigger_event = EXCLUDED.trigger_event;

    SELECT id INTO v_scoring_id FROM workflow_templates WHERE slug = 'scoring_agent';

    DELETE FROM workflow_steps WHERE workflow_template_id = v_scoring_id;

    -- Step 1: Load contact with company
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_scoring_id, 'Load Contact Brief', 'Get contact with company and interaction history', 1, 'tool_call',
        '{"tool_name": "get_contact_brief", "input_mapping": {"contact_id": "{{event.entity_id}}"}}',
        'contact_brief');

    -- Step 2: Load scoring rules
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_scoring_id, 'Load Scoring Rules', 'Get active scoring rules for team', 2, 'tool_call',
        '{"tool_name": "get_scoring_rules", "input_mapping": {"is_active": true}}',
        'scoring_rules');

    -- Step 3: Load product context for ICP comparison
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_scoring_id, 'Load ICP', 'Get ideal customer profile from product context', 3, 'tool_call',
        '{"tool_name": "get_product_context", "input_mapping": {"is_default": true}}',
        'product_context');

    -- Step 4: Calculate score
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_scoring_id, 'Calculate Score', 'Apply scoring rules to contact data', 4, 'ai_prompt',
        '{"prompt_template": "Calculate a lead score (0-100) for this contact based on the scoring rules and ICP fit.\n\n**Contact:**\n{{contact_brief.contact}}\n\n**Company:**\n{{contact_brief.contact.companies}}\n\n**Interaction History:**\n{{contact_brief.interactions}}\n\n**Scoring Rules:**\n{{scoring_rules}}\n\n**Ideal Customer Profile:**\n{{product_context.ideal_customer}}\n\nRespond with JSON:\n{\n  \"score\": <number 0-100>,\n  \"breakdown\": {\n    \"icp_fit\": <0-30>,\n    \"engagement\": <0-25>,\n    \"company_fit\": <0-25>,\n    \"role_fit\": <0-20>\n  },\n  \"reasons\": [<string>, ...],\n  \"recommendation\": \"hot|warm|cold|disqualified\"\n}", "output_type": "json"}',
        'score_result');

    -- Step 5: Update contact score
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_scoring_id, 'Update Score', 'Save new score to contact', 5, 'tool_call',
        '{"tool_name": "update_contact", "input_mapping": {"contact_id": "{{contact_brief.contact.id}}", "score": "{{score_result.score}}", "score_breakdown": "{{score_result.breakdown}}", "score_reasons": "{{score_result.reasons}}"}}',
        'updated_contact');

    -- Step 6: Check for significant score change
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config)
    VALUES (v_scoring_id, 'Check Score Change', 'Emit event if score changed significantly', 6, 'condition_check',
        '{"condition": "Math.abs({{score_result.score}} - {{contact_brief.contact.score}}) >= 10", "on_true": {"action": "emit_event", "event_type": "score.changed", "payload": {"old_score": "{{contact_brief.contact.score}}", "new_score": "{{score_result.score}}", "recommendation": "{{score_result.recommendation}}"}}, "on_false": {"action": "continue"}}');

    -- ============================================================================
    -- NOTIFICATION AGENT WORKFLOW
    -- ============================================================================
    -- Trigger: score.changed (threshold crossings)
    -- Job: Alerter - hot lead alerts, follow-up reminders

    INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system)
    VALUES (
        'Notification Agent',
        'notification_agent',
        'Alerter agent: sends notifications for hot leads, score changes, and follow-up reminders',
        'notification',
        'score.changed',
        true
    ) ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        trigger_event = EXCLUDED.trigger_event;

    SELECT id INTO v_notification_id FROM workflow_templates WHERE slug = 'notification_agent';

    DELETE FROM workflow_steps WHERE workflow_template_id = v_notification_id;

    -- Step 1: Load contact data
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, output_variable)
    VALUES (v_notification_id, 'Load Contact', 'Get contact details for notification', 1, 'tool_call',
        '{"tool_name": "get_contact_brief", "input_mapping": {"contact_id": "{{event.entity_id}}"}}',
        'contact_brief');

    -- Step 2: Check if hot lead (score >= 80)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_notification_id, 'Hot Lead Alert', 'Send alert for hot leads', 2, 'tool_call',
        '{"tool_name": "send_notification", "input_mapping": {"channel": "slack", "template": "hot_lead", "data": {"contact_name": "{{contact_brief.contact.first_name}} {{contact_brief.contact.last_name}}", "company": "{{contact_brief.contact.companies.name}}", "score": "{{event.payload.new_score}}", "reason": "Score increased from {{event.payload.old_score}} to {{event.payload.new_score}}"}}}',
        '[{"field": "{{event.payload.new_score}}", "operator": ">=", "value": 80}]');

    -- Step 3: Check if newly qualified (crossed 50 threshold)
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_notification_id, 'Qualified Lead Alert', 'Send alert when lead becomes qualified', 3, 'tool_call',
        '{"tool_name": "send_notification", "input_mapping": {"channel": "slack", "template": "qualified_lead", "data": {"contact_name": "{{contact_brief.contact.first_name}} {{contact_brief.contact.last_name}}", "company": "{{contact_brief.contact.companies.name}}", "score": "{{event.payload.new_score}}"}}}',
        '[{"field": "{{event.payload.old_score}}", "operator": "<", "value": 50}, {"field": "{{event.payload.new_score}}", "operator": ">=", "value": 50}]');

    -- Step 4: Create follow-up task for hot leads
    INSERT INTO workflow_steps (workflow_template_id, name, description, step_order, action_type, action_config, run_conditions)
    VALUES (v_notification_id, 'Create Follow-up Task', 'Schedule follow-up for hot leads', 4, 'tool_call',
        '{"tool_name": "create_task", "input_mapping": {"contact_id": "{{contact_brief.contact.id}}", "company_id": "{{contact_brief.contact.company_id}}", "type": "call", "priority": 1, "reason": "Hot lead - Score: {{event.payload.new_score}}", "due_date": "tomorrow"}}',
        '[{"field": "{{event.payload.new_score}}", "operator": ">=", "value": 80}]');

END $$;

-- ============================================================================
-- CREATE ADDITIONAL TRIGGER FOR SCORING AGENT
-- ============================================================================
-- Scoring agent should also trigger on intake.basic_lead

INSERT INTO workflow_templates (name, slug, description, category, trigger_event, is_system)
VALUES (
    'Scoring Agent (Basic Lead)',
    'scoring_agent_basic',
    'Scoring agent triggered by basic leads that skipped SDR enrichment',
    'scoring',
    'intake.basic_lead',
    true
) ON CONFLICT (slug) DO NOTHING;

-- Copy steps from main scoring agent (they reference same logic)
-- In practice, the workflow executor would recognize this shares steps with scoring_agent

-- ============================================================================
-- HELPER VIEW: Active Workflows
-- ============================================================================

CREATE OR REPLACE VIEW active_workflows AS
SELECT
    wt.id,
    wt.name,
    wt.slug,
    wt.trigger_event,
    wt.category,
    COUNT(ws.id) as step_count,
    wt.is_active,
    wt.created_at
FROM workflow_templates wt
LEFT JOIN workflow_steps ws ON ws.workflow_template_id = wt.id AND ws.is_enabled = true
WHERE wt.is_active = true
GROUP BY wt.id
ORDER BY wt.trigger_event, wt.name;
