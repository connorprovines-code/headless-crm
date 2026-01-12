/**
 * Workflow Executor
 *
 * Processes events and executes matching workflows.
 * Can be triggered by:
 * 1. Direct API call (triggerEvent / triggerWorkflow)
 * 2. Orchestrator agent calling emitEvent tool
 * 3. Manual trigger via CLI
 */

import { supabase, DEFAULT_TEAM_ID, DEFAULT_USER_ID } from './supabase.js';
import { executeTool } from './tools.js';
import { enrichmentApis } from './enrichment-apis.js';
import Anthropic from '@anthropic-ai/sdk';

// ============================================================================
// CONFIGURATION
// ============================================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ============================================================================
// EVENT EMISSION
// ============================================================================

/**
 * Emit an event that can trigger workflows
 * This is the main entry point for both direct API calls and orchestrator
 *
 * @param {Object} params
 * @param {string} params.event_type - Event type (e.g., 'contact.created', 'intake.new_lead')
 * @param {string} params.entity_type - Entity type (contact, company, deal)
 * @param {string} params.entity_id - UUID of the entity
 * @param {Object} params.payload - Additional event data
 * @param {boolean} params.process_immediately - Whether to process now (default: true)
 */
export async function emitEvent({ event_type, entity_type, entity_id, payload = {}, process_immediately = true }) {
  // Insert event record
  const { data: event, error } = await supabase
    .from('events')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      event_type,
      entity_type,
      entity_id,
      payload,
      source: payload.source || 'api',
      processed: false,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create event: ${error.message}`);
  }

  console.log(`[Event] Emitted: ${event_type} for ${entity_type}:${entity_id}`);

  // Process immediately if requested
  if (process_immediately) {
    const result = await processEvent(event);
    return { event, processing_result: result };
  }

  return { event, processing_result: null };
}

// ============================================================================
// EVENT PROCESSING
// ============================================================================

/**
 * Process a single event - find matching workflows and execute them
 */
export async function processEvent(event) {
  const { id: eventId, event_type, entity_type, entity_id, payload } = event;

  // Check if event has a delay_until timestamp (e.g., from DB triggers)
  if (payload?.delay_until) {
    const delayUntil = new Date(payload.delay_until);
    const now = new Date();
    if (delayUntil > now) {
      const waitMs = delayUntil - now;
      console.log(`[Event] Waiting ${Math.ceil(waitMs / 1000)}s for event delay...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  // Find workflows triggered by this event type
  const { data: workflows, error } = await supabase
    .from('workflow_templates')
    .select(`
      *,
      workflow_steps(*)
    `)
    .eq('trigger_event', event_type)
    .eq('is_active', true)
    .order('workflow_steps(step_order)', { ascending: true });

  if (error) {
    console.error(`[Event] Error finding workflows: ${error.message}`);
    return { success: false, error: error.message };
  }

  if (!workflows || workflows.length === 0) {
    console.log(`[Event] No workflows found for event: ${event_type}`);

    // Mark event as processed
    await supabase
      .from('events')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('id', eventId);

    return { success: true, workflows_run: 0, message: 'No matching workflows' };
  }

  console.log(`[Event] Found ${workflows.length} workflow(s) for: ${event_type}`);

  const results = [];

  // Execute each matching workflow
  for (const workflow of workflows) {
    const result = await executeWorkflow(workflow, {
      event: {
        id: eventId,
        type: event_type,
        entity_type,
        entity_id,
        payload,
      },
    });
    results.push(result);
  }

  // Mark event as processed
  await supabase
    .from('events')
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq('id', eventId);

  return {
    success: true,
    workflows_run: workflows.length,
    results,
  };
}

// ============================================================================
// WORKFLOW EXECUTION
// ============================================================================

/**
 * Execute a workflow with given context
 *
 * @param {Object} workflow - Workflow template with steps
 * @param {Object} context - Initial context (event data, entity data)
 */
export async function executeWorkflow(workflow, initialContext = {}) {
  const workflowId = workflow.id;
  const steps = workflow.workflow_steps?.sort((a, b) => a.step_order - b.step_order) || [];

  console.log(`[Workflow] Starting: ${workflow.name} (${steps.length} steps)`);

  // Create workflow run record
  const { data: run, error: runError } = await supabase
    .from('workflow_runs')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      workflow_template_id: workflowId,
      triggered_by: initialContext.event?.type || 'manual',
      entity_type: initialContext.event?.entity_type,
      entity_id: initialContext.event?.entity_id,
      status: 'running',
      started_at: new Date().toISOString(),
      context: initialContext,
    })
    .select()
    .single();

  if (runError) {
    console.error(`[Workflow] Failed to create run: ${runError.message}`);
    return { success: false, error: runError.message };
  }

  const runId = run.id;
  let context = { ...initialContext };
  let currentStepOrder = 0;
  let shouldStop = false;
  let error = null;

  try {
    for (const step of steps) {
      if (shouldStop) break;

      currentStepOrder = step.step_order;

      // Check run conditions
      if (step.run_conditions && step.run_conditions.length > 0) {
        const conditionsMet = evaluateConditions(step.run_conditions, context);
        if (!conditionsMet) {
          console.log(`[Workflow] Step ${step.step_order}: ${step.name} - Skipped (conditions not met)`);

          await logStepExecution(runId, step, {
            status: 'skipped',
            message: 'Run conditions not met',
          });

          continue;
        }
      }

      console.log(`[Workflow] Step ${step.step_order}: ${step.name}`);

      // Execute the step
      const stepResult = await executeStep(step, context);

      // Log step execution
      await logStepExecution(runId, step, stepResult);

      // Handle step result
      if (stepResult.success) {
        // Store output in context
        if (step.output_variable && stepResult.output !== undefined) {
          context[step.output_variable] = stepResult.output;
        }

        // Check for stop signal
        if (stepResult.stop) {
          shouldStop = true;
          console.log(`[Workflow] Stopping: ${stepResult.stop_reason || 'Step requested stop'}`);
        }

        // Handle emitted events
        if (stepResult.emit_event) {
          await emitEvent({
            event_type: stepResult.emit_event.event_type,
            entity_type: stepResult.emit_event.entity_type || context.event?.entity_type,
            entity_id: stepResult.emit_event.entity_id || context.event?.entity_id,
            payload: stepResult.emit_event.payload || {},
            process_immediately: false, // Queue for later to avoid infinite loops
          });
        }
      } else {
        // Handle error based on on_error setting
        if (step.on_error === 'continue') {
          console.log(`[Workflow] Step ${step.step_order} failed but continuing: ${stepResult.error}`);
          context[step.output_variable || `step_${step.step_order}_error`] = {
            error: true,
            message: stepResult.error,
          };
        } else {
          // Default: stop on error
          error = stepResult.error;
          shouldStop = true;
          console.error(`[Workflow] Step ${step.step_order} failed: ${stepResult.error}`);
        }
      }
    }

    // Update workflow run status
    const finalStatus = error ? 'failed' : (shouldStop ? 'stopped' : 'completed');

    await supabase
      .from('workflow_runs')
      .update({
        status: finalStatus,
        completed_at: new Date().toISOString(),
        error_message: error,
        final_context: context,
      })
      .eq('id', runId);

    console.log(`[Workflow] ${workflow.name}: ${finalStatus}`);

    return {
      success: !error,
      run_id: runId,
      status: finalStatus,
      steps_executed: currentStepOrder,
      error,
      context,
    };
  } catch (e) {
    // Unexpected error
    await supabase
      .from('workflow_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: e.message,
      })
      .eq('id', runId);

    console.error(`[Workflow] Unexpected error: ${e.message}`);

    return {
      success: false,
      run_id: runId,
      status: 'failed',
      error: e.message,
    };
  }
}

// ============================================================================
// STEP EXECUTION
// ============================================================================

async function executeStep(step, context) {
  const { action_type, action_config } = step;
  const config = typeof action_config === 'string' ? JSON.parse(action_config) : action_config;

  switch (action_type) {
    case 'tool_call':
      return await executeToolCall(config, context);

    case 'ai_prompt':
      return await executeAiPrompt(config, context);

    case 'condition_check':
      return await executeConditionCheck(config, context);

    case 'branch':
      return await executeBranch(config, context);

    default:
      return { success: false, error: `Unknown action type: ${action_type}` };
  }
}

/**
 * Execute a tool call
 */
async function executeToolCall(config, context) {
  const toolName = config.tool_name;
  const inputMapping = config.input_mapping || {};

  // Resolve input values from context
  const resolvedInput = resolveTemplateObject(inputMapping, context);

  try {
    let result;

    // Check if it's an enrichment API
    if (enrichmentApis[toolName]) {
      result = await enrichmentApis[toolName](resolvedInput);
    } else if (toolName === 'emit_event') {
      // Special handling for emit_event
      return {
        success: true,
        emit_event: resolvedInput,
        output: { emitted: true, event_type: resolvedInput.event_type },
      };
    } else {
      // Use standard tool
      result = await executeTool(toolName, resolvedInput);
    }

    return {
      success: true,
      output: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Execute an AI prompt
 */
async function executeAiPrompt(config, context) {
  if (!anthropic) {
    return { success: false, error: 'Anthropic API key not configured' };
  }

  const promptTemplate = config.prompt_template;
  const outputType = config.output_type || 'text';
  const maxTokens = config.max_tokens || 1000;

  // Resolve template
  const resolvedPrompt = resolveTemplate(promptTemplate, context);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: resolvedPrompt }],
    });

    let output = response.content[0]?.text || '';

    // Parse JSON if expected
    if (outputType === 'json') {
      try {
        // Extract JSON from markdown code blocks if present
        const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          output = JSON.parse(jsonMatch[1]);
        } else {
          output = JSON.parse(output);
        }
      } catch (e) {
        return { success: false, error: `Failed to parse AI response as JSON: ${e.message}` };
      }
    }

    return {
      success: true,
      output,
      tokens_used: response.usage?.output_tokens,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Execute a condition check
 */
async function executeConditionCheck(config, context) {
  const condition = resolveTemplate(config.condition, context);

  // Evaluate the condition (simple expression evaluator)
  let result;
  try {
    result = evaluateExpression(condition);
  } catch (e) {
    return { success: false, error: `Condition evaluation failed: ${e.message}` };
  }

  if (result) {
    // Execute on_true actions
    return handleBranchAction(config.on_true, context);
  } else {
    // Execute on_false actions
    return handleBranchAction(config.on_false, context);
  }
}

/**
 * Execute a branch with multiple conditions
 */
async function executeBranch(config, context) {
  const branches = config.branches || [];

  for (const branch of branches) {
    const condition = resolveTemplate(branch.condition, context);

    try {
      if (evaluateExpression(condition)) {
        return handleBranchAction(branch, context);
      }
    } catch (e) {
      // Continue to next branch on evaluation error
      continue;
    }
  }

  // No branch matched
  return { success: true, output: { no_match: true } };
}

/**
 * Handle a branch action result
 */
async function handleBranchAction(branchConfig, context) {
  if (!branchConfig) {
    return { success: true, output: null };
  }

  const result = { success: true, output: {} };

  // Handle action
  if (branchConfig.action === 'continue') {
    return result;
  }

  if (branchConfig.action === 'stop') {
    result.stop = true;
    result.stop_reason = branchConfig.reason;
    return result;
  }

  if (branchConfig.action === 'emit_event') {
    result.emit_event = {
      event_type: branchConfig.event_type,
      payload: branchConfig.payload || {},
    };
  }

  if (branchConfig.then === 'stop') {
    result.stop = true;
  }

  if (branchConfig.then === 'emit_event') {
    result.emit_event = {
      event_type: branchConfig.event_type,
      payload: branchConfig.payload || {},
    };
  }

  return result;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Log step execution to workflow_run_logs
 */
async function logStepExecution(runId, step, result) {
  await supabase.from('workflow_run_logs').insert({
    workflow_run_id: runId,
    workflow_step_id: step.id,
    step_order: step.step_order,
    step_name: step.name,
    status: result.success ? 'completed' : (result.status || 'failed'),
    input: result.input,
    output: result.output,
    error_message: result.error,
    tokens_used: result.tokens_used,
    executed_at: new Date().toISOString(),
  });
}

/**
 * Resolve template variables like {{event.entity_id}} in a string
 */
function resolveTemplate(template, context) {
  if (typeof template !== 'string') return template;

  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const value = getNestedValue(context, path.trim());
    if (value === undefined) return match; // Keep original if not found
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Resolve template variables in an object recursively
 */
function resolveTemplateObject(obj, context) {
  if (typeof obj === 'string') {
    return resolveTemplate(obj, context);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => resolveTemplateObject(item, context));
  }

  if (typeof obj === 'object' && obj !== null) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveTemplateObject(value, context);
    }
    return result;
  }

  return obj;
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current?.[key];
  }, obj);
}

/**
 * Evaluate conditions array
 */
function evaluateConditions(conditions, context) {
  for (const condition of conditions) {
    const fieldValue = resolveTemplate(condition.field, context);
    const targetValue = condition.value;
    const operator = condition.operator;

    let result;
    switch (operator) {
      case 'equals':
        result = fieldValue === targetValue;
        break;
      case 'not_equals':
        result = fieldValue !== targetValue;
        break;
      case 'is_empty':
        result = !fieldValue || fieldValue === '';
        break;
      case 'is_not_empty':
        result = fieldValue && fieldValue !== '';
        break;
      case 'contains':
        result = String(fieldValue).includes(String(targetValue));
        break;
      case 'greater_than':
        result = Number(fieldValue) > Number(targetValue);
        break;
      case 'less_than':
        result = Number(fieldValue) < Number(targetValue);
        break;
      default:
        result = false;
    }

    if (!result) return false;
  }

  return true;
}

/**
 * Simple expression evaluator for conditions like "x > 0 && y == 'test'"
 */
function evaluateExpression(expr) {
  // Handle simple comparisons
  // Replace null checks
  expr = expr.replace(/!= null/g, '!== null');
  expr = expr.replace(/== null/g, '=== null');
  expr = expr.replace(/== true/g, '=== true');
  expr = expr.replace(/== false/g, '=== false');

  // For safety, only allow certain characters
  const sanitized = expr.replace(/[^0-9a-zA-Z_\s\.\>\<\=\!\&\|\(\)\"\'\-\+]/g, '');

  try {
    // Using Function instead of eval for slightly better isolation
    return new Function(`return (${sanitized})`)();
  } catch (e) {
    throw new Error(`Invalid expression: ${expr}`);
  }
}

// ============================================================================
// TRIGGER FUNCTIONS (Entry Points)
// ============================================================================

/**
 * Trigger a workflow directly by slug
 */
export async function triggerWorkflow(slug, context = {}) {
  const { data: workflow, error } = await supabase
    .from('workflow_templates')
    .select(`*, workflow_steps(*)`)
    .eq('slug', slug)
    .single();

  if (error || !workflow) {
    throw new Error(`Workflow not found: ${slug}`);
  }

  return await executeWorkflow(workflow, context);
}

/**
 * Process all pending events
 */
export async function processPendingEvents(limit = 10) {
  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('processed', false)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to fetch pending events: ${error.message}`);
  }

  if (!events || events.length === 0) {
    console.log('[Events] No pending events');
    return { processed: 0, results: [] };
  }

  console.log(`[Events] Processing ${events.length} pending event(s)`);

  const results = [];
  for (const event of events) {
    const result = await processEvent(event);
    results.push({ event_id: event.id, event_type: event.event_type, ...result });
  }

  return { processed: events.length, results };
}

// ============================================================================
// TOOL DEFINITIONS FOR ORCHESTRATOR
// ============================================================================

export const workflowToolDefinitions = [
  {
    name: 'emit_event',
    description: 'Emit an event to trigger workflows. Use this to start the agent pipeline or signal state changes.',
    input_schema: {
      type: 'object',
      properties: {
        event_type: {
          type: 'string',
          description: 'Event type (e.g., "contact.created", "intake.new_lead", "sdr.processed")',
        },
        entity_type: {
          type: 'string',
          description: 'Entity type: contact, company, or deal',
        },
        entity_id: {
          type: 'string',
          description: 'UUID of the entity',
        },
        payload: {
          type: 'object',
          description: 'Additional event data',
        },
      },
      required: ['event_type', 'entity_type', 'entity_id'],
    },
  },
  {
    name: 'trigger_workflow',
    description: 'Manually trigger a specific workflow by its slug',
    input_schema: {
      type: 'object',
      properties: {
        workflow_slug: {
          type: 'string',
          description: 'Workflow slug (e.g., "intake_agent", "sdr_agent")',
        },
        entity_type: {
          type: 'string',
          description: 'Entity type',
        },
        entity_id: {
          type: 'string',
          description: 'Entity UUID',
        },
        additional_context: {
          type: 'object',
          description: 'Additional context data for the workflow',
        },
      },
      required: ['workflow_slug'],
    },
  },
  {
    name: 'process_pending_events',
    description: 'Process any pending events in the queue',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max events to process (default 10)',
        },
      },
    },
  },
  {
    name: 'get_workflow_status',
    description: 'Get the status of a workflow run',
    input_schema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'UUID of the workflow run',
        },
      },
      required: ['run_id'],
    },
  },
];

// Executor for workflow tools
export async function executeWorkflowTool(name, input) {
  switch (name) {
    case 'emit_event':
      return await emitEvent(input);

    case 'trigger_workflow':
      return await triggerWorkflow(input.workflow_slug, {
        event: {
          entity_type: input.entity_type,
          entity_id: input.entity_id,
        },
        ...input.additional_context,
      });

    case 'process_pending_events':
      return await processPendingEvents(input.limit);

    case 'get_workflow_status':
      const { data, error } = await supabase
        .from('workflow_runs')
        .select('*, workflow_run_logs(*)')
        .eq('id', input.run_id)
        .single();

      if (error) throw new Error(error.message);
      return data;

    default:
      throw new Error(`Unknown workflow tool: ${name}`);
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  emitEvent,
  processEvent,
  executeWorkflow,
  triggerWorkflow,
  processPendingEvents,
  workflowToolDefinitions,
  executeWorkflowTool,
};
