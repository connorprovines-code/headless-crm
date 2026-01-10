/**
 * Contact Agent
 *
 * Notification router: alerts sales for hot leads, routes support requests,
 * manages follow-ups.
 *
 * Triggers:
 * - sdr.complete (new leads after enrichment)
 * - intake.existing_updated (returning contacts)
 */

export const contactAgent = {
  name: 'Contact Agent',
  slug: 'contact_agent',
  description: 'Notification router: alerts sales for hot leads, routes support requests, manages follow-ups',
  category: 'notification',
  trigger_event: 'sdr.complete',
  version: 1,

  steps: [
    // Step 1: Load contact
    {
      name: 'Load Contact',
      description: 'Get contact details',
      step_order: 1,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'get_contact_brief',
        input_mapping: { contact_id: '{{event.entity_id}}' },
      },
      output_variable: 'contact_brief',
    },

    // Step 2: Hot lead alert (score >= 8)
    {
      name: 'Hot Lead Alert',
      description: 'Notify sales of high-value lead',
      step_order: 2,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'send_notification',
        input_mapping: {
          channel: 'slack',
          template: 'hot_lead',
          data: {
            contact_name: '{{contact_brief.contact.first_name}} {{contact_brief.contact.last_name}}',
            company: '{{contact_brief.contact.company_name}}',
            title: '{{contact_brief.contact.title}}',
            score: '{{event.payload.score}}',
            flags: '{{event.payload.flags}}',
            summary: '{{contact_brief.contact.notes}}',
          },
        },
      },
      run_conditions: [
        { field: '{{event.payload.score}}', operator: '>=', value: 8 },
      ],
    },

    // Step 3: Warm lead alert (score 6-7)
    {
      name: 'Warm Lead Alert',
      description: 'Queue warm lead for follow-up',
      step_order: 3,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'send_notification',
        input_mapping: {
          channel: 'slack',
          template: 'warm_lead',
          data: {
            contact_name: '{{contact_brief.contact.first_name}} {{contact_brief.contact.last_name}}',
            company: '{{contact_brief.contact.company_name}}',
            score: '{{event.payload.score}}',
          },
        },
      },
      run_conditions: [
        { field: '{{event.payload.score}}', operator: '>=', value: 6 },
        { field: '{{event.payload.score}}', operator: '<', value: 8 },
      ],
    },

    // Step 4: Create follow-up task for hot leads
    {
      name: 'Create Follow-up Task',
      description: 'Schedule immediate follow-up for hot leads',
      step_order: 4,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'create_task',
        input_mapping: {
          contact_id: '{{contact_brief.contact.id}}',
          type: 'call',
          priority: 1,
          reason: 'Hot lead - Score: {{event.payload.score}}',
          due_date: 'today',
        },
      },
      run_conditions: [
        { field: '{{event.payload.score}}', operator: '>=', value: 8 },
      ],
    },
  ],
};

/**
 * Contact Agent (Existing Update)
 *
 * Variant for when intake updates an existing contact.
 * Handles support routing, re-engagement, etc.
 */
export const contactAgentExisting = {
  name: 'Contact Agent (Existing Update)',
  slug: 'contact_agent_existing',
  description: 'Contact Agent triggered when intake updates an existing contact (for support routing, etc.)',
  category: 'notification',
  trigger_event: 'intake.existing_updated',
  version: 1,

  steps: [
    // Step 1: Load contact with history
    {
      name: 'Load Contact',
      description: 'Get contact details with interaction history',
      step_order: 1,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'get_contact_brief',
        input_mapping: { contact_id: '{{event.entity_id}}' },
      },
      output_variable: 'contact_brief',
    },

    // Step 2: Determine request type and route
    {
      name: 'Analyze Request',
      description: 'Determine what type of request this is',
      step_order: 2,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `A returning contact has reached out. Analyze their request and determine routing.

**Contact:**
Name: {{contact_brief.contact.first_name}} {{contact_brief.contact.last_name}}
Company: {{contact_brief.contact.company_name}}
Previous Score: {{contact_brief.contact.score}}
Status: {{contact_brief.contact.status}}

**Recent Interactions:**
{{contact_brief.interactions}}

**New Request:**
Type: {{event.payload.request_type}}
Message: {{event.payload.message}}

Determine:
1. Is this a support request, sales inquiry, or general contact?
2. What action should be taken?

Respond with JSON:
{"request_category": "support|sales|general", "urgency": "high|medium|low", "recommended_action": string, "notify_sales": boolean, "create_task": boolean, "task_type": "call|email|follow_up|other", "task_reason": string}`,
        output_type: 'json',
        max_tokens: 250,
      },
      output_variable: 'request_analysis',
    },

    // Step 3: Notify sales if needed
    {
      name: 'Notify Sales',
      description: 'Alert sales team of returning contact',
      step_order: 3,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'send_notification',
        input_mapping: {
          channel: 'slack',
          template: 'returning_contact',
          data: {
            contact_name: '{{contact_brief.contact.first_name}} {{contact_brief.contact.last_name}}',
            company: '{{contact_brief.contact.company_name}}',
            request_type: '{{event.payload.request_type}}',
            message: '{{event.payload.message}}',
            analysis: '{{request_analysis}}',
          },
        },
      },
      run_conditions: [
        { field: '{{request_analysis.notify_sales}}', operator: '==', value: true },
      ],
    },

    // Step 4: Create task if needed
    {
      name: 'Create Task',
      description: 'Create follow-up task based on analysis',
      step_order: 4,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'create_task',
        input_mapping: {
          contact_id: '{{contact_brief.contact.id}}',
          type: '{{request_analysis.task_type}}',
          priority: '{{request_analysis.urgency == "high" ? 1 : request_analysis.urgency == "medium" ? 3 : 5}}',
          reason: '{{request_analysis.task_reason}}',
          due_date: 'today',
        },
      },
      run_conditions: [
        { field: '{{request_analysis.create_task}}', operator: '==', value: true },
      ],
    },
  ],
};

export default contactAgent;
