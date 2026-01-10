import { supabase, DEFAULT_TEAM_ID, DEFAULT_USER_ID } from './supabase.js';

// ============================================================================
// TOOL DEFINITIONS (for Claude API)
// ============================================================================

export const toolDefinitions = [
  {
    name: 'search_companies',
    description: 'Search for companies by name or domain',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term (company name or domain)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_contacts',
    description: 'Search for contacts by name, email, or company',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term (name, email, or company name)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_company_brief',
    description: 'Get a full context dump for a company including contacts, deals, recent interactions',
    input_schema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'UUID of the company',
        },
        company_name: {
          type: 'string',
          description: 'Name of the company (used if company_id not provided)',
        },
      },
    },
  },
  {
    name: 'get_contact_brief',
    description: 'Get full context for a contact including company, interactions, tasks',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: {
          type: 'string',
          description: 'UUID of the contact',
        },
        contact_name: {
          type: 'string',
          description: 'Name of the contact (used if contact_id not provided)',
        },
      },
    },
  },
  {
    name: 'create_company',
    description: 'Create a new company',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company name' },
        domain: { type: 'string', description: 'Website domain (e.g., acme.com)' },
        industry: { type: 'string', description: 'Industry/sector' },
        employee_count: { type: 'string', description: 'Size range: 1-10, 11-50, 51-200, 201-500, 500+' },
        notes: { type: 'string', description: 'Additional notes about the company' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_contact',
    description: 'Create a new contact, optionally linked to a company',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'First name' },
        last_name: { type: 'string', description: 'Last name' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        title: { type: 'string', description: 'Job title' },
        role_type: { type: 'string', description: 'Role type: decision_maker, champion, influencer, blocker, user, other' },
        company_id: { type: 'string', description: 'UUID of the company to link' },
        company_name: { type: 'string', description: 'Company name (used to find/create company if company_id not provided)' },
        notes: { type: 'string', description: 'Additional notes' },
      },
      required: ['first_name'],
    },
  },
  {
    name: 'log_interaction',
    description: 'Log an interaction (call, email, meeting, etc.) with a contact',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'UUID of the contact' },
        contact_name: { type: 'string', description: 'Contact name (used if contact_id not provided)' },
        type: { type: 'string', description: 'Type: call, email_sent, email_received, meeting, linkedin, slack, note' },
        channel: { type: 'string', description: 'Channel: phone, email, linkedin, slack, in_person, video' },
        direction: { type: 'string', description: 'Direction: inbound, outbound' },
        subject: { type: 'string', description: 'Subject/topic of interaction' },
        content: { type: 'string', description: 'Notes or content of the interaction' },
        sentiment: { type: 'string', description: 'Sentiment: positive, neutral, negative' },
        outcome: { type: 'string', description: 'Outcome: connected, voicemail, no_answer, replied, scheduled, etc.' },
        follow_up_date: { type: 'string', description: 'Date to follow up (YYYY-MM-DD)' },
      },
      required: ['type'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a task/follow-up for a contact',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'UUID of the contact' },
        contact_name: { type: 'string', description: 'Contact name (used if contact_id not provided)' },
        type: { type: 'string', description: 'Task type: call, email, follow_up, research, meeting, other' },
        priority: { type: 'number', description: 'Priority 1-10 (1 = highest)' },
        reason: { type: 'string', description: 'Why this task exists' },
        due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
      },
      required: ['type', 'reason'],
    },
  },
  {
    name: 'get_call_list',
    description: 'Get the prioritized call list for today (or a specific date)',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date (YYYY-MM-DD), defaults to today' },
        limit: { type: 'number', description: 'Max tasks to return (default 10)' },
      },
    },
  },
  {
    name: 'update_score',
    description: 'Manually update the score for a contact or company',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Entity type: contact or company' },
        entity_id: { type: 'string', description: 'UUID of the entity' },
        entity_name: { type: 'string', description: 'Name (used if entity_id not provided)' },
        score: { type: 'number', description: 'New score value (0-100)' },
        reason: { type: 'string', description: 'Reason for the score update' },
      },
      required: ['entity_type', 'score'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as completed',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the task' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_open_tasks',
    description: 'List all open (uncompleted) tasks',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max tasks to return (default 20)' },
      },
    },
  },
  // Custom Fields
  {
    name: 'create_custom_field',
    description: 'Create a new custom field that can be tracked on contacts, companies, or deals. Use this when users want to track new data points.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Entity type: contact, company, or deal' },
        field_name: { type: 'string', description: 'Internal field name (will be snake_cased)' },
        field_label: { type: 'string', description: 'Display label for the field' },
        field_type: { type: 'string', description: 'Field type: text, number, date, boolean, select, multi_select, url, email, phone' },
        description: { type: 'string', description: 'Help text describing what this field is for' },
        options: { type: 'array', items: { type: 'string' }, description: 'Options for select/multi_select fields' },
        default_value: { type: 'string', description: 'Default value for new records' },
        is_required: { type: 'boolean', description: 'Whether this field is required' },
      },
      required: ['entity_type', 'field_name', 'field_type'],
    },
  },
  {
    name: 'set_custom_field_value',
    description: 'Set the value of a custom field on a specific contact, company, or deal',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Entity type: contact, company, or deal' },
        entity_id: { type: 'string', description: 'UUID of the entity' },
        entity_name: { type: 'string', description: 'Name of the entity (used if entity_id not provided)' },
        field_name: { type: 'string', description: 'Name of the custom field' },
        value: { description: 'Value to set (type depends on field type)' },
      },
      required: ['entity_type', 'field_name', 'value'],
    },
  },
  {
    name: 'get_custom_fields',
    description: 'List all custom fields defined for an entity type',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Entity type: contact, company, or deal' },
      },
      required: ['entity_type'],
    },
  },
  {
    name: 'list_custom_field_values',
    description: 'Get all custom field values for a specific entity',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Entity type: contact, company, or deal' },
        entity_id: { type: 'string', description: 'UUID of the entity' },
      },
      required: ['entity_type', 'entity_id'],
    },
  },
  // Agent Management
  {
    name: 'list_agents',
    description: 'List all configured agents in the system',
    input_schema: {
      type: 'object',
      properties: {
        include_disabled: { type: 'boolean', description: 'Include disabled agents (default false)' },
      },
    },
  },
  {
    name: 'get_agent_details',
    description: 'Get full details about a specific agent including recent runs',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'UUID of the agent' },
        agent_name: { type: 'string', description: 'Name of the agent (used if agent_id not provided)' },
      },
    },
  },
  {
    name: 'create_agent',
    description: 'Create a new agent configuration. Agents can be triggered manually, by events, on schedule, or chained after other agents.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the agent' },
        description: { type: 'string', description: 'What this agent does' },
        trigger_type: { type: 'string', description: 'Trigger type: manual, event, schedule, or chained' },
        trigger_config: {
          type: 'object',
          description: 'Trigger configuration. For event: {events: ["contact.created"]}. For schedule: {cron: "0 8 * * *"}. For chained: {after_agent: "uuid"}',
        },
        conditions: {
          type: 'array',
          description: 'Conditions that must be met for agent to run. Array of {field, operator, value}',
        },
        actions: {
          type: 'array',
          description: 'Actions the agent performs. Array of action objects like {type: "update_field", target: "contact.score", operation: "increment", value: 10}',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of tool names this agent can use. Empty = all tools.',
        },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'update_agent',
    description: 'Update an existing agent configuration',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'UUID of the agent' },
        agent_name: { type: 'string', description: 'Name of the agent (used if agent_id not provided)' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        is_enabled: { type: 'boolean', description: 'Enable or disable the agent' },
        trigger_type: { type: 'string', description: 'New trigger type' },
        trigger_config: { type: 'object', description: 'New trigger configuration' },
        conditions: { type: 'array', description: 'New conditions' },
        actions: { type: 'array', description: 'New actions' },
        allowed_tools: { type: 'array', items: { type: 'string' }, description: 'New allowed tools list' },
      },
    },
  },
  {
    name: 'get_recent_agent_activity',
    description: 'Get recent activity from all agents (from agent_logs)',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 20)' },
      },
    },
  },
  {
    name: 'get_pending_events',
    description: 'Get events that are waiting to be processed by agents',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max events to return (default 50)' },
      },
    },
  },
];

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

async function logAgentAction(agent, action, entityType, entityId, input, output) {
  try {
    await supabase.from('agent_logs').insert({
      team_id: DEFAULT_TEAM_ID,
      agent,
      action,
      entity_type: entityType,
      entity_id: entityId,
      input,
      output,
    });
  } catch (e) {
    console.error('Failed to log agent action:', e.message);
  }
}

export async function search_companies({ query, limit = 10 }) {
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, domain, industry, employee_count, score')
    .or(`name.ilike.%${query}%,domain.ilike.%${query}%`)
    .limit(limit);

  if (error) throw new Error(error.message);
  return { companies: data, count: data.length };
}

export async function search_contacts({ query, limit = 10 }) {
  const { data, error } = await supabase
    .from('contacts')
    .select(`
      id, first_name, last_name, email, phone, title, score, status,
      companies(id, name)
    `)
    .or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%,email.ilike.%${query}%`)
    .limit(limit);

  if (error) throw new Error(error.message);
  return { contacts: data, count: data.length };
}

export async function get_company_brief({ company_id, company_name }) {
  // Find company by ID or name
  let company;
  if (company_id) {
    const { data, error } = await supabase
      .from('companies')
      .select('*')
      .eq('id', company_id)
      .single();
    if (error) throw new Error(error.message);
    company = data;
  } else if (company_name) {
    const { data, error } = await supabase
      .from('companies')
      .select('*')
      .ilike('name', `%${company_name}%`)
      .limit(1)
      .single();
    if (error) throw new Error(`Company not found: ${company_name}`);
    company = data;
  } else {
    throw new Error('Must provide company_id or company_name');
  }

  // Get contacts
  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, email, title, role_type, score')
    .eq('company_id', company.id);

  // Get deals
  const { data: deals } = await supabase
    .from('deals')
    .select('id, name, stage, value, close_date')
    .eq('company_id', company.id);

  // Get recent interactions
  const { data: interactions } = await supabase
    .from('interactions')
    .select('id, type, subject, sentiment, outcome, created_at')
    .eq('company_id', company.id)
    .order('created_at', { ascending: false })
    .limit(10);

  // Get open tasks
  const { data: tasks } = await supabase
    .from('tasks')
    .select('id, type, priority, reason, due_date')
    .eq('company_id', company.id)
    .is('completed_at', null);

  return {
    company,
    contacts: contacts || [],
    deals: deals || [],
    recent_interactions: interactions || [],
    open_tasks: tasks || [],
  };
}

export async function get_contact_brief({ contact_id, contact_name }) {
  // Find contact
  let contact;
  if (contact_id) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*, companies(id, name, domain, industry)')
      .eq('id', contact_id)
      .single();
    if (error) throw new Error(error.message);
    contact = data;
  } else if (contact_name) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*, companies(id, name, domain, industry)')
      .or(`first_name.ilike.%${contact_name}%,last_name.ilike.%${contact_name}%`)
      .limit(1)
      .single();
    if (error) throw new Error(`Contact not found: ${contact_name}`);
    contact = data;
  } else {
    throw new Error('Must provide contact_id or contact_name');
  }

  // Get interactions
  const { data: interactions } = await supabase
    .from('interactions')
    .select('*')
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: false })
    .limit(15);

  // Get tasks
  const { data: tasks } = await supabase
    .from('tasks')
    .select('*')
    .eq('contact_id', contact.id)
    .is('completed_at', null);

  // Get signals
  const { data: signals } = await supabase
    .from('signals')
    .select('*')
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: false })
    .limit(10);

  return {
    contact,
    interactions: interactions || [],
    open_tasks: tasks || [],
    recent_signals: signals || [],
  };
}

export async function create_company({ name, domain, industry, employee_count, notes }) {
  const { data, error } = await supabase
    .from('companies')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      owner_id: DEFAULT_USER_ID,
      name,
      domain,
      industry,
      employee_count,
      notes,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await logAgentAction('cli', 'create_company', 'company', data.id, { name, domain }, data);
  return { company: data, message: `Created company: ${name}` };
}

export async function create_contact({
  first_name,
  last_name,
  email,
  phone,
  title,
  role_type,
  company_id,
  company_name,
  notes,
}) {
  // Find or create company if company_name provided
  let resolvedCompanyId = company_id;
  if (!resolvedCompanyId && company_name) {
    const { data: existing } = await supabase
      .from('companies')
      .select('id')
      .ilike('name', `%${company_name}%`)
      .limit(1)
      .single();

    if (existing) {
      resolvedCompanyId = existing.id;
    } else {
      // Create the company
      const { data: newCompany, error } = await supabase
        .from('companies')
        .insert({ team_id: DEFAULT_TEAM_ID, owner_id: DEFAULT_USER_ID, name: company_name })
        .select()
        .single();
      if (error) throw new Error(error.message);
      resolvedCompanyId = newCompany.id;
    }
  }

  const { data, error } = await supabase
    .from('contacts')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      owner_id: DEFAULT_USER_ID,
      company_id: resolvedCompanyId,
      first_name,
      last_name,
      email,
      phone,
      title,
      role_type,
      notes,
    })
    .select('*, companies(name)')
    .single();

  if (error) throw new Error(error.message);

  await logAgentAction('cli', 'create_contact', 'contact', data.id, { first_name, last_name, company_name }, data);

  const fullName = [first_name, last_name].filter(Boolean).join(' ');
  const companyInfo = data.companies?.name ? ` at ${data.companies.name}` : '';
  return { contact: data, message: `Created contact: ${fullName}${companyInfo}` };
}

export async function log_interaction({
  contact_id,
  contact_name,
  type,
  channel,
  direction,
  subject,
  content,
  sentiment,
  outcome,
  follow_up_date,
}) {
  // Resolve contact
  let resolvedContactId = contact_id;
  let contact = null;
  if (!resolvedContactId && contact_name) {
    const { data } = await supabase
      .from('contacts')
      .select('id, company_id, first_name, last_name')
      .or(`first_name.ilike.%${contact_name}%,last_name.ilike.%${contact_name}%`)
      .limit(1)
      .single();
    if (data) {
      resolvedContactId = data.id;
      contact = data;
    }
  } else if (resolvedContactId) {
    const { data } = await supabase
      .from('contacts')
      .select('id, company_id, first_name, last_name')
      .eq('id', resolvedContactId)
      .single();
    contact = data;
  }

  if (!resolvedContactId) {
    throw new Error('Contact not found. Please create the contact first.');
  }

  const { data, error } = await supabase
    .from('interactions')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      user_id: DEFAULT_USER_ID,
      contact_id: resolvedContactId,
      company_id: contact?.company_id,
      type,
      channel,
      direction,
      subject,
      content,
      sentiment,
      outcome,
      follow_up_date,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await logAgentAction('cli', 'log_interaction', 'interaction', data.id, { contact_name, type, sentiment }, data);

  const contactFullName = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : 'contact';
  return { interaction: data, message: `Logged ${type} with ${contactFullName}` };
}

export async function create_task({ contact_id, contact_name, type, priority = 5, reason, due_date }) {
  // Resolve contact
  let resolvedContactId = contact_id;
  let contact = null;
  if (!resolvedContactId && contact_name) {
    const { data } = await supabase
      .from('contacts')
      .select('id, company_id, first_name, last_name')
      .or(`first_name.ilike.%${contact_name}%,last_name.ilike.%${contact_name}%`)
      .limit(1)
      .single();
    if (data) {
      resolvedContactId = data.id;
      contact = data;
    }
  }

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      assigned_to: DEFAULT_USER_ID,
      contact_id: resolvedContactId,
      company_id: contact?.company_id,
      type,
      priority,
      reason,
      due_date,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await logAgentAction('cli', 'create_task', 'task', data.id, { type, reason, due_date }, data);

  return { task: data, message: `Created task: ${reason}` };
}

export async function get_call_list({ date, limit = 10 }) {
  const targetDate = date || new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('tasks')
    .select(`
      id, type, priority, reason, due_date,
      contacts(id, first_name, last_name, email, phone, score, companies(name))
    `)
    .is('completed_at', null)
    .lte('due_date', targetDate)
    .order('priority', { ascending: true })
    .order('due_date', { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);

  const callList = (data || []).map((task, idx) => ({
    rank: idx + 1,
    priority: task.priority,
    type: task.type,
    reason: task.reason,
    due_date: task.due_date,
    contact: task.contacts
      ? {
          name: [task.contacts.first_name, task.contacts.last_name].filter(Boolean).join(' '),
          company: task.contacts.companies?.name,
          phone: task.contacts.phone,
          email: task.contacts.email,
          score: task.contacts.score,
        }
      : null,
    task_id: task.id,
  }));

  return { date: targetDate, call_list: callList, count: callList.length };
}

export async function update_score({ entity_type, entity_id, entity_name, score, reason }) {
  const table = entity_type === 'contact' ? 'contacts' : 'companies';

  let resolvedId = entity_id;
  if (!resolvedId && entity_name) {
    const { data } = await supabase
      .from(table)
      .select('id')
      .ilike(entity_type === 'contact' ? 'first_name' : 'name', `%${entity_name}%`)
      .limit(1)
      .single();
    if (data) resolvedId = data.id;
  }

  if (!resolvedId) {
    throw new Error(`${entity_type} not found`);
  }

  const { data, error } = await supabase
    .from(table)
    .update({ score })
    .eq('id', resolvedId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  await logAgentAction('cli', 'update_score', entity_type, resolvedId, { score, reason }, data);

  return { updated: data, message: `Updated ${entity_type} score to ${score}` };
}

export async function complete_task({ task_id }) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', task_id)
    .select()
    .single();

  if (error) throw new Error(error.message);

  await logAgentAction('cli', 'complete_task', 'task', task_id, {}, data);

  return { task: data, message: 'Task marked as completed' };
}

export async function list_open_tasks({ limit = 20 }) {
  const { data, error } = await supabase
    .from('tasks')
    .select(`
      id, type, priority, reason, due_date, created_at,
      contacts(first_name, last_name, companies(name))
    `)
    .is('completed_at', null)
    .order('priority', { ascending: true })
    .order('due_date', { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);

  return { tasks: data, count: data.length };
}

// ============================================================================
// CUSTOM FIELDS
// ============================================================================

export async function create_custom_field({
  entity_type,
  field_name,
  field_label,
  field_type,
  description,
  options,
  default_value,
  is_required,
}) {
  const { data, error } = await supabase
    .from('custom_fields')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      entity_type,
      field_name: field_name.toLowerCase().replace(/\s+/g, '_'),
      field_label: field_label || field_name,
      field_type,
      description,
      options: options ? (Array.isArray(options) ? options : [options]) : null,
      default_value,
      is_required: is_required || false,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await logAgentAction('cli', 'create_custom_field', 'custom_field', data.id, { entity_type, field_name, field_type }, data);

  return { custom_field: data, message: `Created custom field "${field_label || field_name}" on ${entity_type}s` };
}

export async function set_custom_field_value({ entity_type, entity_id, entity_name, field_name, value }) {
  // Resolve entity ID if name provided
  let resolvedEntityId = entity_id;
  if (!resolvedEntityId && entity_name) {
    const table = entity_type === 'contact' ? 'contacts' : entity_type === 'company' ? 'companies' : 'deals';
    const searchField = entity_type === 'contact' ? 'first_name' : 'name';
    const { data } = await supabase.from(table).select('id').ilike(searchField, `%${entity_name}%`).limit(1).single();
    if (data) resolvedEntityId = data.id;
  }

  if (!resolvedEntityId) throw new Error(`${entity_type} not found`);

  // Find the custom field
  const { data: field, error: fieldError } = await supabase
    .from('custom_fields')
    .select('*')
    .eq('entity_type', entity_type)
    .eq('field_name', field_name.toLowerCase().replace(/\s+/g, '_'))
    .single();

  if (fieldError || !field) throw new Error(`Custom field "${field_name}" not found on ${entity_type}s`);

  // Determine which value column to use
  const valueColumn =
    field.field_type === 'number' ? 'value_number' :
    field.field_type === 'date' ? 'value_date' :
    field.field_type === 'boolean' ? 'value_boolean' :
    field.field_type === 'multi_select' ? 'value_json' :
    'value_text';

  const valueObj = { [valueColumn]: field.field_type === 'multi_select' ? value : value };

  // Upsert the value
  const { data, error } = await supabase
    .from('custom_field_values')
    .upsert({
      custom_field_id: field.id,
      entity_id: resolvedEntityId,
      ...valueObj,
    }, { onConflict: 'custom_field_id,entity_id' })
    .select()
    .single();

  if (error) throw new Error(error.message);

  return { value: data, message: `Set ${field.field_label} = "${value}"` };
}

export async function get_custom_fields({ entity_type }) {
  const { data, error } = await supabase
    .from('custom_fields')
    .select('*')
    .eq('entity_type', entity_type)
    .order('sort_order');

  if (error) throw new Error(error.message);

  return { fields: data, count: data.length };
}

export async function list_custom_field_values({ entity_type, entity_id }) {
  // Get all custom fields for this entity type with their values for this entity
  const { data: fields, error: fieldsError } = await supabase
    .from('custom_fields')
    .select(`
      id, field_name, field_label, field_type,
      custom_field_values!left(value_text, value_number, value_date, value_boolean, value_json)
    `)
    .eq('entity_type', entity_type)
    .eq('custom_field_values.entity_id', entity_id);

  if (fieldsError) throw new Error(fieldsError.message);

  const result = (fields || []).map(f => {
    const val = f.custom_field_values?.[0];
    let value = null;
    if (val) {
      value = val.value_text || val.value_number || val.value_date || val.value_boolean || val.value_json;
    }
    return {
      field_name: f.field_name,
      field_label: f.field_label,
      field_type: f.field_type,
      value,
    };
  });

  return { custom_fields: result };
}

// ============================================================================
// AGENT MANAGEMENT
// ============================================================================

export async function list_agents({ include_disabled = false }) {
  let query = supabase
    .from('agent_configs')
    .select('id, name, description, is_enabled, trigger_type, last_run_at, run_count, error_count')
    .order('created_at', { ascending: false });

  if (!include_disabled) {
    query = query.eq('is_enabled', true);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return { agents: data, count: data.length };
}

export async function get_agent_details({ agent_id, agent_name }) {
  let agent;
  if (agent_id) {
    const { data, error } = await supabase.from('agent_configs').select('*').eq('id', agent_id).single();
    if (error) throw new Error(error.message);
    agent = data;
  } else if (agent_name) {
    const { data, error } = await supabase.from('agent_configs').select('*').ilike('name', `%${agent_name}%`).single();
    if (error) throw new Error(`Agent not found: ${agent_name}`);
    agent = data;
  } else {
    throw new Error('Must provide agent_id or agent_name');
  }

  // Get recent runs
  const { data: runs } = await supabase
    .from('agent_runs')
    .select('id, status, started_at, completed_at, entities_affected, tokens_used, error_message')
    .eq('agent_config_id', agent.id)
    .order('created_at', { ascending: false })
    .limit(10);

  return { agent, recent_runs: runs || [] };
}

export async function create_agent({
  name,
  description,
  trigger_type,
  trigger_config,
  conditions,
  actions,
  allowed_tools,
}) {
  const { data, error } = await supabase
    .from('agent_configs')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      created_by: DEFAULT_USER_ID,
      name,
      description,
      trigger_type: trigger_type || 'manual',
      trigger_config: trigger_config || {},
      conditions: conditions || [],
      actions: actions || [],
      allowed_tools: allowed_tools || [],
      is_enabled: true,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await logAgentAction('cli', 'create_agent', 'agent_config', data.id, { name, trigger_type }, data);

  return { agent: data, message: `Created agent: ${name}` };
}

export async function update_agent({
  agent_id,
  agent_name,
  name,
  description,
  is_enabled,
  trigger_type,
  trigger_config,
  conditions,
  actions,
  allowed_tools,
}) {
  // Find agent
  let resolvedId = agent_id;
  if (!resolvedId && agent_name) {
    const { data } = await supabase.from('agent_configs').select('id').ilike('name', `%${agent_name}%`).single();
    if (data) resolvedId = data.id;
  }
  if (!resolvedId) throw new Error('Agent not found');

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (is_enabled !== undefined) updates.is_enabled = is_enabled;
  if (trigger_type !== undefined) updates.trigger_type = trigger_type;
  if (trigger_config !== undefined) updates.trigger_config = trigger_config;
  if (conditions !== undefined) updates.conditions = conditions;
  if (actions !== undefined) updates.actions = actions;
  if (allowed_tools !== undefined) updates.allowed_tools = allowed_tools;

  const { data, error } = await supabase
    .from('agent_configs')
    .update(updates)
    .eq('id', resolvedId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  await logAgentAction('cli', 'update_agent', 'agent_config', resolvedId, updates, data);

  return { agent: data, message: `Updated agent: ${data.name}` };
}

export async function get_recent_agent_activity({ limit = 20 }) {
  const { data, error } = await supabase
    .from('agent_logs')
    .select('id, agent, action, entity_type, entity_id, created_at, output')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return { activity: data, count: data.length };
}

export async function get_pending_events({ limit = 50 }) {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('processed', false)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);

  return { events: data, count: data.length };
}

// ============================================================================
// WORKFLOW HELPER TOOLS
// ============================================================================

export async function get_contact({ contact_id }) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*, companies(id, name, domain)')
    .eq('id', contact_id)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function update_contact({ contact_id, ...updates }) {
  const { data, error } = await supabase
    .from('contacts')
    .update(updates)
    .eq('id', contact_id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function upsert_company({ domain, name, industry, employee_count, enrichment_data }) {
  // Try to find existing company by domain
  let company;
  if (domain) {
    const { data: existing } = await supabase
      .from('companies')
      .select('*')
      .eq('domain', domain)
      .single();

    if (existing) {
      // Update existing
      const { data, error } = await supabase
        .from('companies')
        .update({
          name: name || existing.name,
          industry: industry || existing.industry,
          employee_count: employee_count || existing.employee_count,
          enrichment_data: enrichment_data || existing.enrichment_data,
          enrichment_status: 'complete',
          last_enriched_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return data;
    }
  }

  // Create new company
  const { data, error } = await supabase
    .from('companies')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      owner_id: DEFAULT_USER_ID,
      domain,
      name,
      industry,
      employee_count,
      enrichment_data,
      enrichment_status: 'complete',
      last_enriched_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function normalize_contact({ contact_id }) {
  const { data: contact, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contact_id)
    .single();

  if (error) throw new Error(error.message);

  // Normalize data
  const normalized = {
    ...contact,
    email: contact.email?.toLowerCase().trim(),
    first_name: contact.first_name?.trim(),
    last_name: contact.last_name?.trim(),
  };

  return normalized;
}

export async function classify_email({ email }) {
  if (!email) return { is_personal: true, domain: null };

  const domain = email.split('@')[1]?.toLowerCase();

  // Common personal email domains
  const personalDomains = [
    'gmail.com', 'googlemail.com',
    'yahoo.com', 'yahoo.co.uk',
    'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
    'icloud.com', 'me.com', 'mac.com',
    'aol.com',
    'protonmail.com', 'proton.me',
    'mail.com', 'email.com',
    'yandex.com', 'yandex.ru',
  ];

  const isPersonal = personalDomains.includes(domain);

  return {
    is_personal: isPersonal,
    is_company: !isPersonal,
    domain,
    email,
  };
}

export async function extract_domain({ email }) {
  if (!email) return { domain: null };

  const domain = email.split('@')[1]?.toLowerCase();
  return { domain, email };
}

export async function get_product_context({ is_default }) {
  let query = supabase
    .from('product_context')
    .select('*')
    .eq('team_id', DEFAULT_TEAM_ID)
    .eq('is_active', true);

  if (is_default) {
    query = query.eq('is_default', true);
  }

  const { data, error } = await query.limit(1).single();

  if (error) {
    // Return empty context if none configured
    return {
      name: 'Default Product',
      description: 'No product context configured',
      value_proposition: '',
      ideal_customer: '',
    };
  }

  return data;
}

export async function add_contact_note({ contact_id, note, note_type }) {
  // Add as an interaction of type 'note'
  const { data, error } = await supabase
    .from('interactions')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      user_id: DEFAULT_USER_ID,
      contact_id,
      type: 'note',
      content: note,
      subject: note_type || 'Note',
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function get_scoring_rules({ is_active }) {
  // For now, return default scoring rules
  // This can be expanded to fetch from a scoring_rules table
  return {
    icp_factors: [
      { field: 'title', contains: ['VP', 'Director', 'Head of', 'Manager'], points: 10 },
      { field: 'title', contains: ['CEO', 'CTO', 'CFO', 'Founder'], points: 15 },
    ],
    engagement_factors: [
      { type: 'meeting', points: 20 },
      { type: 'call', points: 10 },
      { type: 'email_received', points: 5 },
    ],
    company_factors: [
      { field: 'employee_count', min: 50, max: 500, points: 15 },
      { field: 'employee_count', min: 500, points: 10 },
    ],
  };
}

export async function send_notification({ channel, template, data }) {
  // Log notification (actual sending would integrate with Slack/email APIs)
  console.log(`[Notification] ${channel}: ${template}`, data);

  await supabase.from('agent_logs').insert({
    team_id: DEFAULT_TEAM_ID,
    agent: 'notification_agent',
    action: `send_${channel}_${template}`,
    entity_type: 'notification',
    input: { channel, template, data },
    output: { sent: true, timestamp: new Date().toISOString() },
  });

  return { success: true, channel, template, data };
}

export async function delete_contact({ contact_id, reason }) {
  // Log before deleting
  await logAgentAction('intake_agent', 'delete_contact', 'contact', contact_id, { reason }, { deleted: true });

  const { error } = await supabase
    .from('contacts')
    .delete()
    .eq('id', contact_id);

  if (error) throw new Error(error.message);

  return { success: true, contact_id, reason };
}

export async function merge_contact_data({ existing_contact_id, new_contact_id, new_data }) {
  // Get existing contact
  const { data: existing, error: fetchError } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', existing_contact_id)
    .single();

  if (fetchError) throw new Error(fetchError.message);

  // Merge: new data fills in blanks, doesn't overwrite existing
  const merged = {
    first_name: existing.first_name || new_data.first_name,
    last_name: existing.last_name || new_data.last_name,
    email: existing.email || new_data.email,
    phone: existing.phone || new_data.phone,
    title: existing.title || new_data.title,
    linkedin_url: existing.linkedin_url || new_data.linkedin_url,
    // Always update these if provided
    last_contacted_at: new Date().toISOString(),
  };

  // Update existing contact
  const { data: updated, error: updateError } = await supabase
    .from('contacts')
    .update(merged)
    .eq('id', existing_contact_id)
    .select()
    .single();

  if (updateError) throw new Error(updateError.message);

  // Delete the duplicate new contact if different
  if (new_contact_id && new_contact_id !== existing_contact_id) {
    await supabase.from('contacts').delete().eq('id', new_contact_id);
  }

  await logAgentAction('intake_agent', 'merge_contact', 'contact', existing_contact_id,
    { new_contact_id, new_data }, updated);

  return { success: true, contact: updated, merged_from: new_contact_id };
}

// ============================================================================
// TOOL DISPATCHER
// ============================================================================

const toolFunctions = {
  // CRM operations
  search_companies,
  search_contacts,
  get_company_brief,
  get_contact_brief,
  create_company,
  create_contact,
  log_interaction,
  create_task,
  get_call_list,
  update_score,
  complete_task,
  list_open_tasks,
  // Custom fields
  create_custom_field,
  set_custom_field_value,
  get_custom_fields,
  list_custom_field_values,
  // Agent management
  list_agents,
  get_agent_details,
  create_agent,
  update_agent,
  get_recent_agent_activity,
  get_pending_events,
  // Workflow helpers
  get_contact,
  update_contact,
  upsert_company,
  normalize_contact,
  classify_email,
  extract_domain,
  get_product_context,
  add_contact_note,
  get_scoring_rules,
  send_notification,
  delete_contact,
  merge_contact_data,
};

export async function executeTool(name, input) {
  const fn = toolFunctions[name];
  if (!fn) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return await fn(input);
}
