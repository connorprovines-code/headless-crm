/**
 * SDR Agent v2
 *
 * Researcher + Scorer: ensures work email, scores lead, enriches based on tier,
 * deep analysis for high-value leads, routes to Contact Agent.
 *
 * Trigger: intake.new_contact
 *
 * Enrichment Tiers:
 * - Deep (7-10): PDL + Hunter + Perplexity deep + LinkedIn + Apollo
 * - Light (5-6): Hunter + Perplexity light
 * - None (0-4): Skip enrichment (save money)
 *
 * Approximate costs:
 * - Deep: ~20¢ per lead
 * - Light: ~3¢ per lead
 * - None: ~1¢ per lead (just AI scoring)
 */

export const sdrAgent = {
  name: 'SDR Agent v2',
  slug: 'sdr_agent_v2',
  description: 'Researcher + Scorer: ensures work email, scores lead, enriches based on tier, deep analysis for high-value, routes to Contact Agent',
  category: 'enrichment',
  trigger_event: 'intake.new_contact',
  version: 2,

  steps: [
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

    // Step 3: If personal email, run PDL to get work email
    {
      name: 'PDL Enrichment',
      description: 'Get work email and additional data from PDL',
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

    // Step 4: Update contact with PDL data if found
    {
      name: 'Update from PDL',
      description: 'Store PDL enrichment data',
      step_order: 4,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'update_contact',
        input_mapping: {
          contact_id: '{{contact.id}}',
          work_email: '{{pdl_data.data.work_email}}',
          personal_email: '{{contact.email}}',
          title: '{{pdl_data.data.title}}',
          linkedin_url: '{{pdl_data.data.linkedin_url}}',
          phone: '{{pdl_data.data.phone}}',
        },
      },
      run_conditions: [
        { field: '{{pdl_data.success}}', operator: '==', value: true },
      ],
    },

    // Step 5: Reload contact with updated data
    {
      name: 'Reload Contact',
      description: 'Get updated contact data',
      step_order: 5,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'get_contact',
        input_mapping: { contact_id: '{{event.entity_id}}' },
      },
      output_variable: 'contact',
    },

    // Step 6: Initial scoring (0-10)
    {
      name: 'Initial Score',
      description: 'Calculate initial lead score based on available data',
      step_order: 6,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `Score this lead from 0-10 based on available information.

**Contact:**
Name: {{contact.first_name}} {{contact.last_name}}
Email: {{contact.work_email || contact.email}}
Title: {{contact.title}}
Company: {{contact.company_name}}
LinkedIn: {{contact.linkedin_url}}

**Scoring Criteria:**
- Title seniority (C-level, VP, Director = high)
- Business email vs personal
- Company domain (enterprise = higher)
- Role relevance
- Data completeness

Respond with JSON:
{"score": <0-10>, "breakdown": {"title_seniority": <0-3>, "email_quality": <0-2>, "company_signal": <0-3>, "data_quality": <0-2>}, "reasons": [<string>], "enrichment_tier": "deep|light|none"}

Tiers: 7-10=deep, 5-6=light, 0-4=none`,
        output_type: 'json',
        max_tokens: 300,
      },
      output_variable: 'initial_score',
    },

    // Step 7: Save initial score
    {
      name: 'Save Initial Score',
      description: 'Store initial score on contact',
      step_order: 7,
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

    // Step 8: Extract domain for company lookup
    {
      name: 'Extract Domain',
      description: 'Get company domain from email',
      step_order: 8,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'extract_domain',
        input_mapping: { email: '{{contact.work_email || contact.email}}' },
      },
      output_variable: 'domain_info',
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: 'in', value: ['deep', 'light'] },
      ],
    },

    // TIER: LIGHT + DEEP - Hunter verify
    {
      name: 'Hunter Verify',
      description: 'Verify email deliverability',
      step_order: 9,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'verify_email_hunter',
        input_mapping: { email: '{{contact.work_email || contact.email}}' },
      },
      output_variable: 'hunter_verify',
      on_error: 'continue',
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: 'in', value: ['deep', 'light'] },
      ],
    },

    // TIER: LIGHT + DEEP - Perplexity (depth varies)
    {
      name: 'Perplexity Research',
      description: 'Company research (depth based on tier)',
      step_order: 10,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'research_company_perplexity',
        input_mapping: {
          company_name: '{{contact.company_name || domain_info.company_name}}',
          domain: '{{domain_info.domain}}',
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
      step_order: 11,
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

    // TIER: DEEP ONLY - Apollo (when enabled)
    {
      name: 'Apollo Enrich',
      description: 'Additional person/company data from Apollo (when enabled)',
      step_order: 12,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'enrich_person_apollo',
        input_mapping: {
          email: '{{contact.work_email || contact.email}}',
          first_name: '{{contact.first_name}}',
          last_name: '{{contact.last_name}}',
          domain: '{{domain_info.domain}}',
        },
      },
      output_variable: 'apollo_data',
      on_error: 'continue',
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: '==', value: 'deep' },
      ],
    },

    // Store all enrichment data
    {
      name: 'Store Enrichment Data',
      description: 'Save all enrichment results to contact',
      step_order: 13,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'update_contact',
        input_mapping: {
          contact_id: '{{contact.id}}',
          enrichment_data: {
            hunter: '{{hunter_verify}}',
            perplexity: '{{perplexity_data}}',
            linkedin: '{{linkedin_data}}',
            apollo: '{{apollo_data}}',
            enriched_at: '{{now()}}',
          },
        },
      },
      run_conditions: [
        { field: '{{initial_score.enrichment_tier}}', operator: 'in', value: ['deep', 'light'] },
      ],
    },

    // DEEP ANALYSIS (7+ only)
    {
      name: 'Deep Analysis',
      description: 'Synthesize all data, generate insights for high-value leads',
      step_order: 14,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `You are analyzing a high-value lead. Synthesize all available data and provide actionable intelligence.

**Contact:**
{{contact}}

**LinkedIn Data:**
{{linkedin_data}}

**Company Research:**
{{perplexity_data}}

**Apollo Data:**
{{apollo_data}}

**Hunter Verification:**
{{hunter_verify}}

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
      step_order: 15,
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
      step_order: 16,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `Re-evaluate this lead score based on enrichment data.

**Initial Score:** {{initial_score.score}}/10
**Initial Reasons:** {{initial_score.reasons}}

**New Information:**
- Deep Analysis: {{deep_analysis}}
- Email Valid: {{hunter_verify.data.status}}
- LinkedIn Activity: {{linkedin_data.data.posts.length || 0}} posts

**Adjustments:**
+1-2 for: decision maker confirmed, recent activity, strong company fit, budget signals
-1-2 for: invalid email, no engagement, mismatched role, risk factors

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
      step_order: 17,
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

    // Route to Contact Agent
    {
      name: 'Route to Contact Agent',
      description: 'Hand off to Contact Agent for notification/routing',
      step_order: 18,
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
            source: 'sdr_agent',
          },
        },
      },
    },
  ],
};

export default sdrAgent;
