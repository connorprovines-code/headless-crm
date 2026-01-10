/**
 * Intake Agent v2
 *
 * Gatekeeper: Extracts fields, checks spam, dedupes, routes contacts.
 *
 * Trigger: contact.created
 * Routes: NEW contacts → SDR Agent, EXISTING contacts → Contact Agent
 */

export const intakeAgent = {
  name: 'Intake Agent v2',
  slug: 'intake_agent_v2',
  description: 'Gatekeeper: extracts all fields, checks spam, dedupes, routes to SDR (new) or Contact (existing)',
  category: 'intake',
  trigger_event: 'contact.created',
  version: 2,

  steps: [
    // Step 1: Extract all fields from incoming data
    {
      name: 'Extract All Fields',
      description: 'Parse and extract all available contact information from any format',
      step_order: 1,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `Extract all contact information from this input. Be thorough - pull everything available.

Input:
{{event.payload}}

Extract and return JSON with these fields (use null if not found):
{
  "first_name": string,
  "last_name": string,
  "email": string,
  "phone": string,
  "company": string,
  "title": string,
  "linkedin_url": string,
  "website": string,
  "message": string,
  "source": string,
  "request_type": string (sales|support|partnership|other),
  "additional_fields": object
}`,
        output_type: 'json',
        max_tokens: 500,
      },
      output_variable: 'extracted_data',
    },

    // Step 2: Spam detection
    {
      name: 'Spam Detection',
      description: 'Check if contact appears to be spam',
      step_order: 2,
      action_type: 'ai_prompt',
      action_config: {
        prompt_template: `Analyze this contact for spam signals:

{{extracted_data}}

Check for:
- Gibberish names or emails
- Known spam domains
- Suspicious patterns
- Bot-like behavior

Respond with JSON:
{"is_spam": boolean, "confidence": number 0-1, "reason": string}`,
        output_type: 'json',
        max_tokens: 150,
      },
      output_variable: 'spam_check',
    },

    // Step 3: Handle spam - delete and exit
    {
      name: 'Handle Spam',
      description: 'Delete spam contacts',
      step_order: 3,
      action_type: 'condition_check',
      action_config: {
        condition: '{{spam_check.is_spam}} == true && {{spam_check.confidence}} > 0.7',
        on_true: {
          action: 'delete_contact',
          contact_id: '{{event.entity_id}}',
          then: 'emit_event',
          event_type: 'intake.spam_deleted',
          finally: 'stop',
        },
        on_false: { action: 'continue' },
      },
    },

    // Step 4: Check for existing contact (dedupe)
    {
      name: 'Dedupe Check',
      description: 'Search for existing contact by email',
      step_order: 4,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'search_contacts',
        input_mapping: {
          email: '{{extracted_data.email}}',
          exact_match: true,
          exclude_id: '{{event.entity_id}}',
        },
      },
      output_variable: 'existing_contact',
    },

    // Step 5a: If EXISTS - update and route to Contact Agent
    {
      name: 'Update Existing Contact',
      description: 'Merge new data into existing contact',
      step_order: 5,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'merge_contact_data',
        input_mapping: {
          existing_contact_id: '{{existing_contact.id}}',
          new_contact_id: '{{event.entity_id}}',
          new_data: '{{extracted_data}}',
        },
      },
      run_conditions: [
        { field: '{{existing_contact.count}}', operator: '>', value: 0 },
      ],
    },

    {
      name: 'Route Existing to Contact Agent',
      description: 'Send updated contact to Contact Agent',
      step_order: 6,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'emit_event',
        input_mapping: {
          event_type: 'intake.existing_updated',
          entity_type: 'contact',
          entity_id: '{{existing_contact.id}}',
          payload: {
            source: 'intake',
            request_type: '{{extracted_data.request_type}}',
            message: '{{extracted_data.message}}',
          },
        },
      },
      run_conditions: [
        { field: '{{existing_contact.count}}', operator: '>', value: 0 },
      ],
    },

    // Step 5b: If NEW - update contact with extracted data and route to SDR
    {
      name: 'Save New Contact',
      description: 'Store extracted data on new contact',
      step_order: 7,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'update_contact',
        input_mapping: {
          contact_id: '{{event.entity_id}}',
          first_name: '{{extracted_data.first_name}}',
          last_name: '{{extracted_data.last_name}}',
          email: '{{extracted_data.email}}',
          phone: '{{extracted_data.phone}}',
          title: '{{extracted_data.title}}',
          linkedin_url: '{{extracted_data.linkedin_url}}',
        },
      },
      run_conditions: [
        { field: '{{existing_contact.count}}', operator: '==', value: 0 },
      ],
    },

    {
      name: 'Route New to SDR Agent',
      description: 'Send new contact to SDR Agent for enrichment',
      step_order: 8,
      action_type: 'tool_call',
      action_config: {
        tool_name: 'emit_event',
        input_mapping: {
          event_type: 'intake.new_contact',
          entity_type: 'contact',
          entity_id: '{{event.entity_id}}',
          payload: {
            source: 'intake',
            extracted_data: '{{extracted_data}}',
          },
        },
      },
      run_conditions: [
        { field: '{{existing_contact.count}}', operator: '==', value: 0 },
      ],
    },
  ],
};

export default intakeAgent;
