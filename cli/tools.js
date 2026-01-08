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
// TOOL DISPATCHER
// ============================================================================

const toolFunctions = {
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
};

export async function executeTool(name, input) {
  const fn = toolFunctions[name];
  if (!fn) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return await fn(input);
}
