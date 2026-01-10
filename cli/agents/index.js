/**
 * Agent Registry
 *
 * Central export for all agent definitions.
 * Agents are defined as JavaScript objects and can be:
 * 1. Synced to the database via syncAgents()
 * 2. Executed directly via the workflow executor
 */

import { intakeAgent } from './intake-agent.js';
import { sdrAgent } from './sdr-agent.js';
import { contactAgent, contactAgentExisting } from './contact-agent.js';
import { supabase, DEFAULT_TEAM_ID } from '../supabase.js';

// ============================================================================
// AGENT REGISTRY
// ============================================================================

export const agents = {
  intake_agent_v2: intakeAgent,
  sdr_agent_v2: sdrAgent,
  contact_agent: contactAgent,
  contact_agent_existing: contactAgentExisting,
};

// ============================================================================
// DATABASE SYNC
// ============================================================================

/**
 * Sync agent definitions to the database
 * Creates/updates workflow_templates and workflow_steps
 */
export async function syncAgents(agentSlugs = null) {
  const toSync = agentSlugs
    ? agentSlugs.map(slug => agents[slug]).filter(Boolean)
    : Object.values(agents);

  const results = [];

  for (const agent of toSync) {
    try {
      const result = await syncAgent(agent);
      results.push({ slug: agent.slug, success: true, ...result });
    } catch (error) {
      results.push({ slug: agent.slug, success: false, error: error.message });
    }
  }

  return results;
}

/**
 * Sync a single agent to the database
 */
async function syncAgent(agent) {
  // Upsert workflow template
  const { data: template, error: templateError } = await supabase
    .from('workflow_templates')
    .upsert({
      name: agent.name,
      slug: agent.slug,
      description: agent.description,
      category: agent.category,
      trigger_event: agent.trigger_event,
      is_system: true,
      is_active: true,
      version: agent.version,
    }, { onConflict: 'slug' })
    .select()
    .single();

  if (templateError) {
    throw new Error(`Failed to upsert template: ${templateError.message}`);
  }

  // Delete existing steps
  await supabase
    .from('workflow_steps')
    .delete()
    .eq('workflow_template_id', template.id);

  // Insert new steps
  const steps = agent.steps.map(step => ({
    workflow_template_id: template.id,
    name: step.name,
    description: step.description,
    step_order: step.step_order,
    action_type: step.action_type,
    action_config: step.action_config,
    output_variable: step.output_variable || null,
    run_conditions: step.run_conditions || null,
    on_error: step.on_error || 'stop',
    is_enabled: true,
  }));

  const { error: stepsError } = await supabase
    .from('workflow_steps')
    .insert(steps);

  if (stepsError) {
    throw new Error(`Failed to insert steps: ${stepsError.message}`);
  }

  return {
    template_id: template.id,
    steps_count: steps.length,
    version: agent.version,
  };
}

/**
 * Get agent by slug (from registry, not database)
 */
export function getAgent(slug) {
  return agents[slug] || null;
}

/**
 * List all registered agents
 */
export function listAgents() {
  return Object.entries(agents).map(([slug, agent]) => ({
    slug,
    name: agent.name,
    category: agent.category,
    trigger_event: agent.trigger_event,
    version: agent.version,
    steps_count: agent.steps.length,
  }));
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  intakeAgent,
  sdrAgent,
  contactAgent,
  contactAgentExisting,
};

export default agents;
