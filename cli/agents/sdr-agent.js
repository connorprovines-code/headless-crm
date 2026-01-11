/**
 * SDR Agent v2
 *
 * Researcher + Scorer: ensures work email, scores lead, enriches based on tier,
 * deep analysis for high-value leads, routes to Contact Agent.
 *
 * Trigger: intake.new_contact
 *
 * Work Email Flow:
 * 1. Classify email (personal vs business)
 * 2. If personal → PDL for company info (name, LinkedIn, title, industry)
 * 3. If no work email yet → derive domain from company → Generect to find/validate email
 *
 * Enrichment Tiers (after initial score):
 * - Deep (7-10): Perplexity deep + LinkedIn + full analysis
 * - Light (5-6): Perplexity light
 * - None (0-4): Skip enrichment (save money)
 *
 * Approximate costs:
 * - Deep: ~8-10¢ per lead (Generect $0.03 + Perplexity + LinkedIn)
 * - Light: ~5¢ per lead (Generect $0.03 + Perplexity light)
 * - None: ~4¢ per lead (Generect $0.03 + AI scoring only)
 */

export const sdrAgent = {
  name: 'SDR Agent v2',
  slug: 'sdr_agent_v2',
  description: 'Researcher + Scorer: ensures work email via Generect, scores lead, enriches based on tier, routes to Contact Agent',
  category: 'enrichment',
  trigger_event: 'intake.new_contact',
  version: 4,

  steps: [
    // =========================================================================
    // PHASE 1: Load and Classify
    // =========================================================================

    // Step 1: Load contact data
    {
      name: 'Load Contact',
      description: 'Get current contact data',
      step_order: 1,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'get_contact',
        input_mapping: { contact_id: '{{event.entity_id}}' },
      },
      output_variable: 'contact',
    },

    // Step 2: Check if email is business email
    {
      name: 'Check Email Type',
      description: 'Determine if email is business or personal',
      step_order: 2,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'classify_email',
        input_mapping: { email: '{{contact.email}}' },
      },
      output_variable: 'email_type',
    },

    // =========================================================================
    // PHASE 2: Get Company Info (PDL) - if personal email
    // =========================================================================

    // Step 3: If personal email, run PDL to get company info
    {
      name: 'PDL Enrichment',
      description: 'Get company info, LinkedIn, title from PDL',
      step_order: 3,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'enrich_person_pdl',
        input_mapping: {
          email: '{{contact.email}}',
          first_name: '{{contact.first_name}}',
          last_name: '{{contact.last_name}}',
          linkedin_url: '{{contact.linkedin_url}}',
        },
      },
      output_variable: 'pdl_data',
      on_error: 'continue',
      run_conditions: [
        { field: '{{email_type.is_personal}}', operator: '==', value: true },
      ],
    },

    // Step 4: Update contact with PDL data (company, title, linkedin - NOT work_email)
    {
      name: 'Update from PDL',
      description: 'Store PDL enrichment data (company info)',
      step_order: 4,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'update_contact',
        input_mapping: {
          contact_id: '{{contact.id}}',
          personal_email: '{{contact.email}}',
          title: '{{pdl_data.data.title}}',
          linkedin_url: '{{pdl_data.data.linkedin_url}}',
          company_name: '{{pdl_data.data.company}}',
        },
      },
      run_conditions: [
        { field: '{{pdl_data.success}}', operator: '==', value: true },
      ],
    },

    // Step 5: Reload contact with updated data
    {
      name: 'Reload Contact',
      description: 'Get updated contact data after PDL',
      step_order: 5,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'get_contact',
        input_mapping: { contact_id: '{{event.entity_id}}' },
      },
      output_variable: 'contact',
    },

    // =========================================================================
    // PHASE 3: Find Work Email (Generect) - if we have company info
    // =========================================================================

    // Step 6: Derive domain from company name using AI
    {
      name: 'Derive Company Domain',
      description: 'Figure out company domain from company name',
      step_order: 6,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `Given this company name, determine the most likely corporate email domain.

Company Name: {{contact.company_name || pdl_data.data.company}}

Rules:
- Use the company's primary website domain
- For well-known companies, use the standard domain (e.g., "Microsoft" → "microsoft.com")
- For less known companies, make a reasonable guess based on the name
- Remove spaces, use lowercase
- Common patterns: companyname.com, company.com, thecompany.com

Respond with JSON only:
{"domain": "company.com", "confidence": "high|medium|low"}`,
        output_type: 'json',
        max_tokens: 100,
      },
      output_variable: 'derived_domain',
      run_conditions: [
        { field: '{{contact.work_email}}', operator: 'is_empty' },
        { field: '{{contact.company_name || pdl_data.data.company}}', operator: 'is_not_empty' },
      ],
    },

    // Step 7: Use Generect to find validated work email
    {
      name: 'Generect Email Finder',
      description: 'Find and validate work email using Generect ($0.03/success)',
      step_order: 7,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'find_email_generect',
        input_mapping: {
          first_name: '{{contact.first_name}}',
          last_name: '{{contact.last_name}}',
          domain: '{{derived_domain.domain}}',
        },
      },
      output_variable: 'generect_result',
      on_error: 'continue',
      run_conditions: [
        { field: '{{contact.work_email}}', operator: 'is_empty' },
        { field: '{{derived_domain.domain}}', operator: 'is_not_empty' },
      ],
    },

    // Step 8: Save work email from Generect
    {
      name: 'Save Work Email',
      description: 'Store validated work email from Generect',
      step_order: 8,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'update_contact',
        input_mapping: {
          contact_id: '{{contact.id}}',
          work_email: '{{generect_result.data.email}}',
          email_verified: true,
        },
      },
      run_conditions: [
        { field: '{{generect_result.success}}', operator: '==', value: true },
      ],
    },

    // Step 9: Reload contact with work email
    {
      name: 'Reload with Work Email',
      description: 'Get contact data with work email',
      step_order: 9,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'get_contact',
        input_mapping: { contact_id: '{{event.entity_id}}' },
      },
      output_variable: 'contact',
    },

    // =========================================================================
    // PHASE 4: Initial Scoring
    // =========================================================================

    // Step 10a: Load ICP and scoring rules from config
    {
      name: 'Load ICP Config',
      description: 'Get ICP definition from team config',
      step_order: 10,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'get_config',
        input_mapping: { config_key: 'icp' },
      },
      output_variable: 'icp_config',
      on_error: 'continue',
    },

    // Step 10b: Load scoring rules
    {
      name: 'Load Scoring Rules',
      description: 'Get scoring rules from team config',
      step_order: 11,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'get_config',
        input_mapping: { config_key: 'scoring_rules' },
      },
      output_variable: 'scoring_config',
      on_error: 'continue',
    },

    // Step 11: Initial scoring (0-10) - now uses dynamic ICP
    {
      name: 'Initial Score',
      description: 'Calculate initial lead score based on ICP and available data',
      step_order: 12,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `Score this lead from 0-10 based on the Ideal Customer Profile (ICP) and available information.

**Contact:**
Name: {{contact.first_name}} {{contact.last_name}}
Work Email: {{contact.work_email}}
Personal Email: {{contact.personal_email || contact.email}}
Title: {{contact.title}}
Company: {{contact.company_name}}
LinkedIn: {{contact.linkedin_url}}

**Ideal Customer Profile (ICP):**
{{icp_config.config || "No ICP configured - use general B2B scoring"}}

**Scoring Rules:**
{{scoring_config.config || "Use default: base_score=5, title +1-3, work_email +2, company_fit +1-2"}}

Apply the ICP criteria:
- High-value titles from ICP get more points
- Preferred industries from ICP get bonus
- Company size in ideal range gets bonus
- Excluded industries or negative signals reduce score

Respond with JSON:
{"score": <0-10>, "breakdown": {"title_seniority": <0-3>, "email_quality": <0-2>, "company_signal": <0-3>, "data_quality": <0-2>}, "reasons": [<string>], "enrichment_tier": "deep|light|none", "icp_match": "strong|moderate|weak|poor"}

Enrichment tiers from config or default: 7-10=deep, 5-6=light, 0-4=none`,
        output_type: 'json',
        max_tokens: 400,
      },
      output_variable: 'initial_score',
    },

    // Step 13: Save initial score
    {
      name: 'Save Initial Score',
      description: 'Store initial score on contact',
      step_order: 13,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'update_contact',
        input_mapping: {
          contact_id: '{{contact.id}}',
          score: '{{initial_score.score}}',
          score_breakdown: '{{initial_score.breakdown}}',
          enrichment_tier: '{{initial_score.enrichment_tier}}',
        },
      },
    },

    // =========================================================================
    // PHASE 5: Tiered Enrichment (based on score)
    // =========================================================================

    // Step 14: Perplexity Research (both tiers, depth varies)
    {
      name: 'Perplexity Research',
      description: 'Company research (depth based on tier)',
      step_order: 14,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'research_company_perplexity',
        input_mapping: {
          company_name: '{{contact.company_name}}',
          domain: '{{derived_domain.domain}}',
          depth: '{{initial_score.enrichment_tier}}',
        },
      },
      output_variable: 'perplexity_data',
      on_error: 'continue',
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: 'in', value: ['deep', 'light'] },
      ],
    },

    // TIER: DEEP ONLY - LinkedIn
    {
      name: 'LinkedIn Scrape',
      description: 'Get LinkedIn posts and profile data (max 10 posts)',
      step_order: 15,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'scrape_linkedin_profile',
        input_mapping: {
          linkedin_url: '{{contact.linkedin_url}}',
          limit: 10,
        },
      },
      output_variable: 'linkedin_data',
      on_error: 'continue',
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: '==', value: 'deep' },
        { field: '{{contact.linkedin_url}}', operator: 'is_not_empty' },
      ],
    },

    // Store all enrichment data
    {
      name: 'Store Enrichment Data',
      description: 'Save all enrichment results to contact',
      step_order: 16,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'update_contact',
        input_mapping: {
          contact_id: '{{contact.id}}',
          enrichment_data: {
            pdl: '{{pdl_data}}',
            generect: '{{generect_result}}',
            perplexity: '{{perplexity_data}}',
            linkedin: '{{linkedin_data}}',
            enriched_at: '{{now()}}',
          },
        },
      },
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: 'in', value: ['deep', 'light'] },
      ],
    },

    // =========================================================================
    // PHASE 6: Deep Analysis (7+ only)
    // =========================================================================

    {
      name: 'Deep Analysis',
      description: 'Synthesize all data, generate insights for high-value leads',
      step_order: 17,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `You are analyzing a high-value lead. Synthesize all available data and provide actionable intelligence.

**Contact:**
Name: {{contact.first_name}} {{contact.last_name}}
Work Email: {{contact.work_email}}
Title: {{contact.title}}
Company: {{contact.company_name}}
LinkedIn: {{contact.linkedin_url}}

**LinkedIn Data:**
{{linkedin_data}}

**Company Research:**
{{perplexity_data}}

Provide:
1. **Executive Summary** (2-3 sentences)
2. **Key Talking Points** (3-5 bullets)
3. **Pain Points** (likely challenges)
4. **Flags** (array: decision_maker, budget_holder, technical, recent_funding, hiring, competitor_user, etc.)
5. **Recommended Approach**
6. **Risk Factors**

Respond with JSON:
{"summary": string, "talking_points": [string], "pain_points": [string], "flags": [string], "recommended_approach": string, "risk_factors": [string], "sales_notes": string}`,
        output_type: 'json',
        max_tokens: 800,
      },
      output_variable: 'deep_analysis',
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: '==', value: 'deep' },
      ],
    },

    // Store deep analysis
    {
      name: 'Store Analysis',
      description: 'Save deep analysis to contact',
      step_order: 18,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'update_contact',
        input_mapping: {
          contact_id: '{{contact.id}}',
          flags: '{{deep_analysis.flags}}',
          sales_notes: '{{deep_analysis.sales_notes}}',
          notes: '{{deep_analysis.summary}}',
        },
      },
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: '==', value: 'deep' },
      ],
    },

    // Re-score after deep enrichment
    {
      name: 'Re-Score',
      description: 'Update score based on enrichment findings',
      step_order: 19,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `Re-evaluate this lead score based on enrichment data.

**Initial Score:** {{initial_score.score}}/10
**Initial Reasons:** {{initial_score.reasons}}

**New Information:**
- Deep Analysis: {{deep_analysis}}
- Work Email Found: {{contact.work_email ? 'Yes' : 'No'}}
- LinkedIn Activity: {{linkedin_data.data.posts.length || 0}} posts

**Adjustments:**
+1-2 for: decision maker confirmed, recent activity, strong company fit, budget signals
-1-2 for: no work email, no engagement, mismatched role, risk factors

Respond with JSON:
{"new_score": <0-10>, "score_change": <number>, "adjustment_reasons": [string]}`,
        output_type: 'json',
        max_tokens: 200,
      },
      output_variable: 'rescore',
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: '==', value: 'deep' },
      ],
    },

    // Update final score
    {
      name: 'Update Final Score',
      description: 'Store re-scored value',
      step_order: 20,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'update_contact',
        input_mapping: {
          contact_id: '{{contact.id}}',
          score: '{{rescore.new_score}}',
          score_breakdown: {
            initial: '{{initial_score.breakdown}}',
            adjustments: '{{rescore.adjustment_reasons}}',
          },
        },
      },
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: '==', value: 'deep' },
      ],
    },

    // =========================================================================
    // PHASE 7: Route to Contact Agent
    // =========================================================================

    {
      name: 'Route to Contact Agent',
      description: 'Hand off to Contact Agent for notification/routing',
      step_order: 21,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'emit_event',
        input_mapping: {
          event_type: 'sdr.complete',
          entity_type: 'contact',
          entity_id: '{{contact.id}}',
          payload: {
            score: '{{rescore.new_score || initial_score.score}}',
            enrichment_tier: '{{initial_score.enrichment_tier}}',
            flags: '{{deep_analysis.flags || []}}',
            has_work_email: '{{contact.work_email ? true : false}}',
            source: 'sdr_agent',
          },
        },
      },
    },
  ],
};

export default sdrAgent;
