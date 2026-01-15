import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Model mapping - allows workflow steps to specify model tier
const MODELS = {
  haiku: "claude-3-5-haiku-20241022",
  sonnet: "claude-sonnet-4-20250514",
  default: "claude-sonnet-4-20250514"
};

// Cache for Anthropic API key
let cachedAnthropicKey: string | null = null;

async function getAnthropicApiKey(): Promise<string | null> {
  if (cachedAnthropicKey) return cachedAnthropicKey;
  try {
    const { data, error } = await supabase.from("integrations").select("credentials").eq("name", "anthropic").eq("is_enabled", true).single();
    if (error || !data) { console.log("[AI] No anthropic integration found"); return null; }
    cachedAnthropicKey = data.credentials?.api_key || null;
    return cachedAnthropicKey;
  } catch (e) { console.log("[AI] Error loading anthropic key:", e.message); return null; }
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    }
    const payload = await req.json();
    console.log("[process-event] Received payload:", JSON.stringify(payload));
    let event;
    if (payload.type === "INSERT" && payload.record) { event = payload.record; }
    else if (payload.id && payload.event_type) { event = payload; }
    else { return new Response(JSON.stringify({ error: "Invalid payload format" }), { status: 400, headers: { "Content-Type": "application/json" } }); }
    if (event.processed) { return new Response(JSON.stringify({ message: "Event already processed", event_id: event.id }), { headers: { "Content-Type": "application/json" } }); }
    if (event.payload?.delay_until) {
      const delayUntil = new Date(event.payload.delay_until);
      const now = new Date();
      if (delayUntil > now) { const waitMs = delayUntil.getTime() - now.getTime(); console.log(`[process-event] Waiting ${Math.ceil(waitMs / 1000)}s for delay...`); await new Promise((resolve) => setTimeout(resolve, waitMs)); }
    }
    const result = await processEvent(event);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (error) { console.error("[process-event] Error:", error); return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } }); }
});

async function processEvent(event: any) {
  const { id: eventId, event_type, entity_type, entity_id, payload, team_id } = event;
  console.log(`[process-event] Processing: ${event_type} for ${entity_type}:${entity_id?.slice(0, 8)}...`);
  const { data: workflows, error } = await supabase.from("workflow_templates").select(`*, workflow_steps(*)`).eq("trigger_event", event_type).eq("is_active", true);
  if (error) { console.error(`[process-event] Error finding workflows: ${error.message}`); return { success: false, error: error.message }; }
  if (!workflows || workflows.length === 0) { console.log(`[process-event] No workflows found for event: ${event_type}`); await markEventProcessed(eventId); return { success: true, workflows_run: 0, message: "No matching workflows" }; }
  console.log(`[process-event] Found ${workflows.length} workflow(s) for: ${event_type}`);
  const results = [];
  for (const workflow of workflows) { const result = await executeWorkflow(workflow, { event: { id: eventId, type: event_type, entity_type, entity_id, payload }, team_id }); results.push(result); }
  await markEventProcessed(eventId);
  return { success: true, workflows_run: workflows.length, results };
}

async function markEventProcessed(eventId: string) { await supabase.from("events").update({ processed: true, processed_at: new Date().toISOString() }).eq("id", eventId); }

async function executeWorkflow(workflow: any, initialContext: any) {
  const workflowId = workflow.id;
  const steps = workflow.workflow_steps?.sort((a: any, b: any) => a.step_order - b.step_order) || [];
  console.log(`[Workflow] Starting: ${workflow.name} (${steps.length} steps)`);
  const { data: run, error: runError } = await supabase.from("workflow_runs").insert({ team_id: initialContext.team_id, workflow_template_id: workflowId, triggered_by: initialContext.event?.type || "manual", entity_type: initialContext.event?.entity_type, entity_id: initialContext.event?.entity_id, status: "running", started_at: new Date().toISOString(), context: initialContext }).select().single();
  if (runError) { console.error(`[Workflow] Failed to create run: ${runError.message}`); return { success: false, error: runError.message }; }
  const runId = run.id;
  let context = { ...initialContext };
  let currentStepOrder = 0;
  let shouldStop = false;
  let workflowError = null;
  try {
    for (const step of steps) {
      if (shouldStop) break;
      currentStepOrder = step.step_order;
      if (step.run_conditions && step.run_conditions.length > 0) {
        const conditionsMet = evaluateConditions(step.run_conditions, context);
        if (!conditionsMet) { console.log(`[Workflow] Step ${step.step_order}: ${step.name} - Skipped (conditions not met)`); await logStepExecution(runId, step, { success: true, status: "skipped", message: "Run conditions not met" }); continue; }
      }
      console.log(`[Workflow] Step ${step.step_order}: ${step.name}`);
      const stepResult = await executeStep(step, context);
      await logStepExecution(runId, step, stepResult);
      if (stepResult.success) {
        if (step.output_variable && stepResult.output !== undefined) { context[step.output_variable] = stepResult.output; }
        if (stepResult.stop) { shouldStop = true; console.log(`[Workflow] Stopping: ${stepResult.stop_reason || "Step requested stop"}`); }
        if (stepResult.emit_event) { await emitEvent({ event_type: stepResult.emit_event.event_type, entity_type: stepResult.emit_event.entity_type || context.event?.entity_type, entity_id: stepResult.emit_event.entity_id || context.event?.entity_id, payload: stepResult.emit_event.payload || {}, team_id: context.team_id }); }
      } else { console.log(`[Workflow] Step ${step.step_order} failed but continuing: ${stepResult.error}`); context[step.output_variable || `step_${step.step_order}_error`] = { error: true, message: stepResult.error }; }
    }
    const finalStatus = workflowError ? "failed" : shouldStop ? "stopped" : "completed";
    await supabase.from("workflow_runs").update({ status: finalStatus, completed_at: new Date().toISOString(), error_message: workflowError, final_context: context }).eq("id", runId);
    console.log(`[Workflow] ${workflow.name}: ${finalStatus}`);
    return { success: !workflowError, run_id: runId, status: finalStatus, steps_executed: currentStepOrder, error: workflowError };
  } catch (e) { await supabase.from("workflow_runs").update({ status: "failed", completed_at: new Date().toISOString(), error_message: e.message }).eq("id", runId); console.error(`[Workflow] Unexpected error: ${e.message}`); return { success: false, run_id: runId, status: "failed", error: e.message }; }
}

async function executeStep(step: any, context: any) {
  const { action_type, action_config } = step;
  const config = typeof action_config === "string" ? JSON.parse(action_config) : action_config;
  switch (action_type) {
    case "tool_call": return await executeToolCall(config, context);
    case "ai_prompt": return await executeAiPrompt(config, context);
    case "condition_check": return await executeConditionCheck(config, context);
    case "branch": return await executeBranch(config, context);
    default: return { success: false, error: `Unknown action type: ${action_type}` };
  }
}

async function executeToolCall(config: any, context: any) {
  const toolName = config.tool_name;
  const inputMapping = config.input_mapping || {};
  const resolvedInput = resolveTemplateObject(inputMapping, context);
  try {
    let result;
    if (enrichmentApis[toolName]) { result = await enrichmentApis[toolName](resolvedInput); }
    else if (toolName === "emit_event") { return { success: true, emit_event: resolvedInput, output: { emitted: true, event_type: resolvedInput.event_type } }; }
    else if (toolFunctions[toolName]) { result = await toolFunctions[toolName](resolvedInput); }
    else { return { success: false, error: `Unknown tool: ${toolName}` }; }
    return { success: true, output: result };
  } catch (error) { return { success: false, error: error.message }; }
}

async function executeAiPrompt(config: any, context: any) {
  const apiKey = await getAnthropicApiKey();
  if (!apiKey) { console.log("[AI] Skipping - no API key configured"); return { success: true, output: { skipped: true, reason: "No API key" } }; }

  const promptTemplate = config.prompt_template;
  const outputType = config.output_type || "text";
  const maxTokens = config.max_tokens || 1000;
  // Model selection: use config.model if specified, otherwise default to sonnet
  const modelKey = config.model || "default";
  const model = MODELS[modelKey] || MODELS.default;

  const resolvedPrompt = resolveTemplate(promptTemplate, context);
  console.log(`[AI] Using model: ${model} (${modelKey})`);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: resolvedPrompt }] })
    });
    if (!response.ok) { const errorText = await response.text(); return { success: false, error: `Anthropic API error: ${response.status} - ${errorText}` }; }
    const data = await response.json();
    let output = data.content?.[0]?.text || "";
    if (outputType === "json") {
      try {
        const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        output = jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(output);
      } catch (e) { return { success: false, error: `Failed to parse AI response as JSON: ${e.message}` }; }
    }
    return { success: true, output, tokens_used: data.usage?.output_tokens, model_used: model };
  } catch (error) { return { success: false, error: error.message }; }
}

async function executeConditionCheck(config: any, context: any) {
  const condition = resolveTemplate(config.condition, context);
  let result;
  try { result = evaluateExpression(condition); } catch (e) { console.log(`[Condition] Evaluation failed: ${e.message}, defaulting to false`); result = false; }
  return result ? handleBranchAction(config.on_true, context) : handleBranchAction(config.on_false, context);
}

async function executeBranch(config: any, context: any) {
  const branches = config.branches || [];
  for (const branch of branches) { const condition = resolveTemplate(branch.condition, context); try { if (evaluateExpression(condition)) { return handleBranchAction(branch, context); } } catch (_e) { continue; } }
  return { success: true, output: { no_match: true } };
}

function handleBranchAction(branchConfig: any, _context: any) {
  if (!branchConfig) return { success: true, output: null };
  const result: any = { success: true, output: {} };
  if (branchConfig.action === "continue") return result;
  if (branchConfig.action === "stop") { result.stop = true; result.stop_reason = branchConfig.reason; return result; }
  if (branchConfig.action === "emit_event") { result.emit_event = { event_type: branchConfig.event_type, payload: branchConfig.payload || {} }; }
  if (branchConfig.then === "stop") result.stop = true;
  if (branchConfig.then === "emit_event") { result.emit_event = { event_type: branchConfig.event_type, payload: branchConfig.payload || {} }; }
  return result;
}

async function emitEvent(params: { event_type: string; entity_type: string; entity_id: string; payload?: any; team_id?: string }) {
  const { data, error } = await supabase.from("events").insert({ team_id: params.team_id, event_type: params.event_type, entity_type: params.entity_type, entity_id: params.entity_id, payload: params.payload || {}, source: "workflow", processed: false }).select().single();
  if (error) throw new Error(`Failed to emit event: ${error.message}`);
  console.log(`[Event] Emitted: ${params.event_type} for ${params.entity_type}:${params.entity_id}`);
  return data;
}

async function logStepExecution(runId: string, step: any, result: any) {
  await supabase.from("workflow_run_logs").insert({
    workflow_run_id: runId, workflow_step_id: step.id, step_order: step.step_order, step_name: step.name,
    status: result.success ? (result.status || "completed") : "failed",
    input: result.input, output: result.output, error_message: result.error,
    tokens_used: result.tokens_used, executed_at: new Date().toISOString()
  });
}

function resolveTemplate(template: any, context: any): string {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{([^}]+)\}\}/g, (match: string, path: string) => { const value = getNestedValueWithFallback(context, path.trim()); if (value === undefined || value === null) return match; if (typeof value === "object") return JSON.stringify(value); return String(value); });
}

function resolveTemplateObject(obj: any, context: any): any {
  if (typeof obj === "string") {
    const pureTemplateMatch = obj.match(/^\{\{([^}]+)\}\}$/);
    if (pureTemplateMatch) { const value = getNestedValueWithFallback(context, pureTemplateMatch[1].trim()); return value; }
    return obj.replace(/\{\{([^}]+)\}\}/g, (match: string, path: string) => { const value = getNestedValueWithFallback(context, path.trim()); if (value === undefined || value === null) return ""; if (typeof value === "object") return JSON.stringify(value); return String(value); });
  }
  if (Array.isArray(obj)) return obj.map((item) => resolveTemplateObject(item, context));
  if (typeof obj === "object" && obj !== null) { const result: any = {}; for (const [key, value] of Object.entries(obj)) { const resolved = resolveTemplateObject(value, context); if (resolved !== undefined) { result[key] = resolved; } } return result; }
  return obj;
}

function getNestedValueWithFallback(obj: any, path: string): any {
  if (path.includes("||")) { const parts = path.split("||").map(p => p.trim()); for (const part of parts) { const value = getNestedValue(obj, part); if (value !== undefined && value !== null && value !== "") { return value; } } return undefined; }
  return getNestedValue(obj, path);
}

function getNestedValue(obj: any, path: string): any { return path.split(".").reduce((current, key) => current?.[key], obj); }

function evaluateConditions(conditions: any[], context: any): boolean {
  for (const condition of conditions) {
    const fieldValue = getNestedValueWithFallback(context, condition.field.replace(/\{\{|\}\}/g, "").trim());
    const targetValue = condition.value;
    const operator = condition.operator;
    let result;
    switch (operator) {
      case "equals": if (typeof targetValue === "boolean") { result = fieldValue === targetValue; } else { result = String(fieldValue) === String(targetValue); } break;
      case "not_equals": result = fieldValue !== targetValue; break;
      case "is_empty": result = !fieldValue || fieldValue === ""; break;
      case "is_not_empty": result = fieldValue && fieldValue !== ""; break;
      case "contains": result = String(fieldValue).includes(String(targetValue)); break;
      case "greater_than": result = Number(fieldValue) > Number(targetValue); break;
      case "less_than": result = Number(fieldValue) < Number(targetValue); break;
      default: result = false;
    }
    if (!result) return false;
  }
  return true;
}

function evaluateExpression(expr: string): boolean {
  expr = expr.replace(/!= null/g, "!== null").replace(/== null/g, "=== null");
  expr = expr.replace(/== true/g, "=== true").replace(/== false/g, "=== false");
  expr = expr.replace(/"true"/g, "true").replace(/"false"/g, "false");
  expr = expr.replace(/'true'/g, "true").replace(/'false'/g, "false");
  const sanitized = expr.replace(/[^0-9a-zA-Z_\s\.\>\<\=\!\&\|\(\)\"\'\'\-\+]/g, "");
  try { return new Function(`return (${sanitized})`)(); } catch (e) { throw new Error(`Invalid expression: ${expr}`); }
}

// ===========================================
// TOOL FUNCTIONS
// ===========================================
const toolFunctions: Record<string, (input: any) => Promise<any>> = {
  get_contact: async ({ contact_id }) => {
    const { data, error } = await supabase.from("contacts").select("*, companies(id, name, domain)").eq("id", contact_id).single();
    if (error) throw new Error(error.message);
    return data;
  },

  update_contact: async ({ contact_id, ...updates }) => {
    const cleanUpdates: any = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== null && value !== undefined && value !== "") { cleanUpdates[key] = value; }
    }
    if (Object.keys(cleanUpdates).length === 0) {
      const { data } = await supabase.from("contacts").select().eq("id", contact_id).single();
      return data;
    }
    const { data, error } = await supabase.from("contacts").update(cleanUpdates).eq("id", contact_id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  // Parse and store ALL intake payload fields into contact record
  parse_intake_payload: async ({ contact_id, payload }) => {
    if (!payload || typeof payload !== "object") return { parsed: false, reason: "No payload" };

    // Field mapping: payload field -> contact column
    const fieldMap: Record<string, string> = {
      // Direct mappings
      source: "source",
      source_detail: "source_detail",
      utm_source: "utm_source",
      utm_medium: "utm_medium",
      utm_campaign: "utm_campaign",
      company: "company_name",
      company_name: "company_name",
      company_size: "company_size",
      size: "company_size",
      industry: "industry",
      title: "title",
      job_title: "title",
      role: "title",
      tech_stack: "tech_stack",
      technologies: "tech_stack",
      message: "message",
      how_can_we_help: "message",
      question: "message",
      comments: "message",
      phone: "phone",
      linkedin: "linkedin_url",
      linkedin_url: "linkedin_url",
    };

    const updates: any = {};
    const customFields: any = {};

    for (const [key, value] of Object.entries(payload)) {
      if (!value) continue;
      const lowerKey = key.toLowerCase().replace(/[^a-z0-9_]/g, "_");

      if (fieldMap[lowerKey]) {
        updates[fieldMap[lowerKey]] = value;
      } else if (!['delay_until', 'email_type', 'pdl_enriched'].includes(lowerKey)) {
        // Store unmapped fields in custom_fields
        customFields[key] = value;
      }
    }

    // Handle tech_stack as array
    if (updates.tech_stack && typeof updates.tech_stack === "string") {
      updates.tech_stack = updates.tech_stack.split(",").map((t: string) => t.trim());
    }

    // Merge custom fields
    if (Object.keys(customFields).length > 0) {
      const { data: existing } = await supabase.from("contacts").select("custom_fields").eq("id", contact_id).single();
      updates.custom_fields = { ...(existing?.custom_fields || {}), ...customFields };
    }

    if (Object.keys(updates).length === 0) return { parsed: true, fields_updated: 0 };

    const { data, error } = await supabase.from("contacts").update(updates).eq("id", contact_id).select().single();
    if (error) throw new Error(error.message);

    console.log(`[parse_intake_payload] Updated ${Object.keys(updates).length} fields`);
    return { parsed: true, fields_updated: Object.keys(updates).length, updated_fields: Object.keys(updates), contact: data };
  },

  // Check if contact exists and get their history
  check_existing_contact: async ({ email }) => {
    if (!email) return { exists: false };

    const { data: contacts, error } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, status, score, lead_type, inbound_count, last_inbound_at, company_id")
      .eq("email", email.toLowerCase())
      .limit(1);

    if (error || !contacts || contacts.length === 0) return { exists: false };

    const contact = contacts[0];

    // Get recent interactions
    const { data: interactions } = await supabase
      .from("interactions")
      .select("id, type, subject, sentiment, created_at")
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false })
      .limit(5);

    // Get any open deals
    const { data: deals } = await supabase
      .from("deals")
      .select("id, name, stage, value")
      .eq("company_id", contact.company_id)
      .not("stage", "in", "(closed_won,closed_lost)");

    // Determine contact type
    let contactType = "new";
    if (contact.inbound_count && contact.inbound_count > 0) {
      const daysSinceLastInbound = contact.last_inbound_at
        ? Math.floor((Date.now() - new Date(contact.last_inbound_at).getTime()) / (1000 * 60 * 60 * 24))
        : 999;

      if (daysSinceLastInbound < 30) contactType = "returning";
      else if (daysSinceLastInbound < 180) contactType = "reengagement";
      else contactType = "dormant";
    }
    if (deals && deals.length > 0) contactType = "existing_customer";

    return {
      exists: true,
      contact,
      contact_type: contactType,
      recent_interactions: interactions || [],
      open_deals: deals || [],
      has_open_deals: (deals?.length || 0) > 0
    };
  },

  // Update multi-touch tracking
  update_inbound_tracking: async ({ contact_id }) => {
    const { data: contact } = await supabase.from("contacts").select("inbound_count").eq("id", contact_id).single();
    const newCount = (contact?.inbound_count || 0) + 1;

    const { data, error } = await supabase
      .from("contacts")
      .update({
        inbound_count: newCount,
        last_inbound_at: new Date().toISOString()
      })
      .eq("id", contact_id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return { inbound_count: newCount, contact: data };
  },

  normalize_contact: async ({ contact_id }) => {
    const { data: contact, error } = await supabase.from("contacts").select("*").eq("id", contact_id).single();
    if (error) throw new Error(error.message);
    return { ...contact, email: contact.email?.toLowerCase().trim(), first_name: contact.first_name?.trim(), last_name: contact.last_name?.trim() };
  },

  search_contacts: async ({ email, query, limit = 10 }) => {
    let q = supabase.from("contacts").select("id, first_name, last_name, email");
    if (email) { q = q.eq("email", email.toLowerCase()); }
    else if (query) { q = q.or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%,email.ilike.%${query}%`); }
    const { data, error } = await q.limit(limit);
    if (error) throw new Error(error.message);
    return { contacts: data || [], count: data?.length || 0 };
  },

  classify_email: async ({ email }) => {
    if (!email) return { is_personal: true, domain: null };
    const domain = email.split("@")[1]?.toLowerCase();
    const personalDomains = ["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me", "mail.com", "email.com"];
    const isPersonal = personalDomains.includes(domain);
    return { is_personal: isPersonal, is_company: !isPersonal, domain, email };
  },

  extract_domain: async ({ email }) => {
    if (!email) return { domain: null };
    return { domain: email.split("@")[1]?.toLowerCase(), email };
  },

  upsert_company: async ({ domain, name, industry, employee_count, enrichment_data }) => {
    const cleanData: any = {};
    if (domain) cleanData.domain = domain;
    if (name) cleanData.name = name;
    if (industry) cleanData.industry = industry;
    if (employee_count) cleanData.employee_count = employee_count;
    if (enrichment_data) cleanData.enrichment_data = enrichment_data;

    if (domain) {
      const { data: existing } = await supabase.from("companies").select("*").eq("domain", domain).single();
      if (existing) {
        const { data, error } = await supabase.from("companies").update({
          name: cleanData.name || existing.name,
          industry: cleanData.industry || existing.industry,
          employee_count: cleanData.employee_count || existing.employee_count,
          enrichment_data: cleanData.enrichment_data || existing.enrichment_data,
          enrichment_status: "complete",
          last_enriched_at: new Date().toISOString()
        }).eq("id", existing.id).select().single();
        if (error) throw new Error(error.message);
        return data;
      }
    }
    const { data, error } = await supabase.from("companies").insert({ ...cleanData, enrichment_status: "complete", last_enriched_at: new Date().toISOString() }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  add_contact_note: async ({ contact_id, note, note_type }) => {
    const { data, error } = await supabase.from("interactions").insert({ contact_id, type: "note", content: note, subject: note_type || "Note" }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  delete_contact: async ({ contact_id, reason }) => {
    console.log(`[Tool] Deleting contact ${contact_id}: ${reason}`);
    const { error } = await supabase.from("contacts").delete().eq("id", contact_id);
    if (error) throw new Error(error.message);
    return { success: true, contact_id, reason };
  },

  get_icp: async () => {
    const { data, error } = await supabase.from("team_config").select("config_value").eq("config_key", "icp").single();
    if (error) {
      console.log("[get_icp] No ICP found, using default");
      return { titles: ["CEO", "CTO", "VP Engineering", "Head of Product"], company_size: { min: 50, max: 500 }, industries: ["Technology", "SaaS", "Software"], signals: ["Recently funded", "Hiring", "New executive"] };
    }
    return data.config_value;
  },

  get_product_context: async () => {
    const { data, error } = await supabase.from("team_config").select("config_value").eq("config_key", "product_context").single();
    if (error) {
      console.log("[get_product_context] No product context found");
      return { name: "Our Product", description: "A headless CRM for modern sales teams", value_props: ["AI-powered lead scoring", "Automated enrichment", "Natural language interface"] };
    }
    return data.config_value;
  },
};

// ===========================================
// ENRICHMENT APIs
// ===========================================
async function getCredentials(integrationName: string) {
  const { data, error } = await supabase.from("integrations").select("credentials").eq("name", integrationName).eq("is_enabled", true).single();
  if (error || !data) throw new Error(`No active ${integrationName} integration found.`);
  return data.credentials;
}

const enrichmentApis: Record<string, (input: any) => Promise<any>> = {
  enrich_person_pdl: async ({ email, first_name, last_name, company, linkedin_url }) => {
    try {
      const credentials = await getCredentials("peopledatalabs");
      const body: any = {};
      if (email) body.email = email;
      if (first_name) body.first_name = first_name;
      if (last_name) body.last_name = last_name;
      if (company) body.company = company;
      if (linkedin_url) body.profile = linkedin_url;
      const response = await fetch("https://api.peopledatalabs.com/v5/person/enrich", { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": credentials.api_key }, body: JSON.stringify(body) });
      if (!response.ok) return { success: false, error: `PDL API error: ${response.status}` };
      const data = await response.json();
      const personData = data.data || {};
      return {
        success: true,
        data: {
          first_name: personData.first_name || null,
          last_name: personData.last_name || null,
          work_email: personData.work_email || null,
          linkedin_url: personData.linkedin_url || null,
          title: personData.job_title || null,
          company: personData.job_company_name || null,
          company_domain: personData.job_company_website || null,
          location: personData.location_name || null,
          industry: personData.industry || null
        }
      };
    } catch (error) { return { success: false, error: error.message }; }
  },

  find_email_hunter: async ({ domain, first_name, last_name }) => {
    try {
      const credentials = await getCredentials("hunter");
      const params = new URLSearchParams({ domain, api_key: credentials.api_key });
      if (first_name) params.append("first_name", first_name);
      if (last_name) params.append("last_name", last_name);
      const response = await fetch(`https://api.hunter.io/v2/email-finder?${params}`);
      if (!response.ok) return { success: false, error: `Hunter API error: ${response.status}` };
      const data = await response.json();
      return { success: true, data: { email: data.data?.email, score: data.data?.score, verification_status: data.data?.verification?.status } };
    } catch (error) { return { success: false, error: error.message }; }
  },

  verify_email_hunter: async ({ email }) => {
    try {
      const credentials = await getCredentials("hunter");
      const params = new URLSearchParams({ email, api_key: credentials.api_key });
      const response = await fetch(`https://api.hunter.io/v2/email-verifier?${params}`);
      if (!response.ok) return { success: false, error: `Hunter API error: ${response.status}` };
      const data = await response.json();
      return { success: true, data: { status: data.data?.status, score: data.data?.score, is_disposable: data.data?.disposable, is_webmail: data.data?.webmail } };
    } catch (error) { return { success: false, error: error.message }; }
  },

  scrape_linkedin_profile: async ({ linkedin_url, limit = 10 }) => {
    if (!linkedin_url) return { success: true, data: null, message: "No LinkedIn URL provided" };
    try {
      const credentials = await getCredentials("apify");
      let username = linkedin_url;
      if (linkedin_url?.includes("linkedin.com/in/")) username = linkedin_url.split("linkedin.com/in/")[1].replace(/\/$/, "");
      const response = await fetch(`https://api.apify.com/v2/acts/apimaestro~linkedin-profile-posts/run-sync-get-dataset-items?token=${credentials.token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, limit: Math.min(Math.max(limit, 1), 100) }) });
      if (!response.ok) return { success: false, error: `Apify API error: ${response.status}` };
      const items = await response.json();
      const profile = items[0];
      if (!profile) return { success: true, data: null, message: "No profile data" };
      return { success: true, data: { name: profile.name || profile.fullName, headline: profile.headline, summary: profile.summary || profile.about, location: profile.location, experience: profile.experience, education: profile.education, skills: profile.skills, recent_posts: items.slice(0, 5).map((p: any) => ({ text: p.text?.slice(0, 200), reactions: p.totalReactionCount })) } };
    } catch (error) { return { success: false, error: error.message }; }
  },

  research_company_perplexity: async ({ company_name, domain, depth = "light" }) => {
    try {
      const credentials = await getCredentials("perplexity");
      const isDeep = depth === "deep";
      let query = company_name || domain;
      if (domain && company_name) query += ` (${domain})`;
      query += isDeep ? " - company overview, recent news, funding, competitors" : " - company overview";
      const response = await fetch("https://api.perplexity.ai/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.api_key}` }, body: JSON.stringify({ query, max_results: isDeep ? 10 : 3, search_recency_filter: "month" }) });
      if (!response.ok) return { success: false, error: `Perplexity API error: ${response.status}` };
      const data = await response.json();
      return { success: true, data: { company_name, domain, depth, results: data.results?.map((r: any) => ({ title: r.title, url: r.url, snippet: r.snippet })) || [] } };
    } catch (error) { return { success: false, error: error.message }; }
  },
};
