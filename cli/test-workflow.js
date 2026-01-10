#!/usr/bin/env node
/**
 * Test Script for Workflow Execution
 *
 * Usage:
 *   node test-workflow.js                    # Run full test
 *   node test-workflow.js --emit-only        # Just emit contact.created event
 *   node test-workflow.js --process-pending  # Process pending events
 *   node test-workflow.js --trigger intake   # Trigger specific workflow
 *   node test-workflow.js --check-logs       # View recent workflow logs
 */

import 'dotenv/config';
import { supabase, DEFAULT_TEAM_ID, DEFAULT_USER_ID } from './supabase.js';
import { emitEvent, triggerWorkflow, processPendingEvents } from './workflow-executor.js';
import { create_contact } from './tools.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

async function log(msg, data = null) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[TEST] ${msg}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log('='.repeat(60));
}

async function checkCredentials() {
  console.log('\n[Check] Verifying API credentials...');

  const integrations = ['peopledatalabs', 'hunter', 'apollo_enrichment', 'apify', 'perplexity'];
  const results = [];

  for (const name of integrations) {
    const { data } = await supabase
      .from('integrations')
      .select('id, name, is_enabled')
      .is('team_id', null)
      .eq('name', name)
      .single();

    results.push({
      integration: name,
      configured: !!data,
      active: data?.is_enabled || false,
    });
  }

  console.table(results);

  const missing = results.filter(r => !r.configured);
  if (missing.length > 0) {
    console.log('\n[Warning] Missing integrations. To configure, run:');
    console.log(`
INSERT INTO integrations (name, display_name, credentials, is_enabled)
VALUES
  ('peopledatalabs', 'People Data Labs', '{"api_key": "YOUR_KEY"}', true),
  ('hunter', 'Hunter.io', '{"api_key": "YOUR_KEY"}', true),
  ('apify', 'Apify', '{"token": "YOUR_TOKEN"}', true),
  ('perplexity', 'Perplexity AI', '{"api_key": "YOUR_KEY"}', true);
    `);
  }

  return missing.length === 0;
}

async function checkWorkflows() {
  console.log('\n[Check] Verifying workflows...');

  const { data: workflows } = await supabase
    .from('workflow_templates')
    .select('slug, name, trigger_event, is_active')
    .eq('is_active', true);

  if (!workflows || workflows.length === 0) {
    console.log('[Error] No active workflows found. Run migration 007.');
    return false;
  }

  console.table(workflows);
  return true;
}

// ============================================================================
// TEST SCENARIOS
// ============================================================================

async function testFullPipeline() {
  await log('Starting Full Pipeline Test');

  // 1. Check prerequisites
  const hasCredentials = await checkCredentials();
  const hasWorkflows = await checkWorkflows();

  if (!hasWorkflows) {
    console.log('\n[Error] Cannot proceed without workflows. Run migration 007.');
    return;
  }

  // 2. Create a test contact
  await log('Creating test contact...');

  const testContact = {
    first_name: 'Test',
    last_name: 'User',
    email: 'test.user@acmecorp.com', // Company email
    title: 'VP of Engineering',
    company_name: 'Acme Corp',
  };

  let contact;
  try {
    const result = await create_contact(testContact);
    contact = result.contact;
    await log('Contact created', contact);
  } catch (e) {
    await log('Error creating contact', { error: e.message });
    return;
  }

  // 3. Emit contact.created event
  await log('Emitting contact.created event...');

  try {
    const eventResult = await emitEvent({
      event_type: 'contact.created',
      entity_type: 'contact',
      entity_id: contact.id,
      payload: { source: 'test_script' },
      process_immediately: true,
    });

    await log('Event processing result', eventResult);
  } catch (e) {
    await log('Error processing event', { error: e.message });
  }

  // 4. Check workflow run logs
  await showRecentLogs(contact.id);
}

async function testEmitOnly() {
  await log('Emit-Only Test');

  // Create minimal contact
  const { data: contact, error } = await supabase
    .from('contacts')
    .insert({
      team_id: DEFAULT_TEAM_ID,
      owner_id: DEFAULT_USER_ID,
      first_name: 'Quick',
      last_name: 'Test',
      email: 'quick.test@example.com',
    })
    .select()
    .single();

  if (error) {
    await log('Error creating contact', { error: error.message });
    return;
  }

  await log('Contact created', { id: contact.id, email: contact.email });

  // Emit event but don't process immediately
  const eventResult = await emitEvent({
    event_type: 'contact.created',
    entity_type: 'contact',
    entity_id: contact.id,
    payload: { source: 'test_emit_only' },
    process_immediately: false,
  });

  await log('Event emitted (not processed)', eventResult);
  console.log('\nRun with --process-pending to process this event.');
}

async function testProcessPending() {
  await log('Processing Pending Events');

  const result = await processPendingEvents(5);
  await log('Processing complete', result);
}

async function testTriggerWorkflow(slug) {
  await log(`Triggering workflow: ${slug}`);

  // Get a recent contact
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, email')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!contact) {
    console.log('[Error] No contacts found. Create one first.');
    return;
  }

  await log('Using contact', contact);

  const result = await triggerWorkflow(slug, {
    event: {
      entity_type: 'contact',
      entity_id: contact.id,
    },
  });

  await log('Workflow result', result);
}

async function showRecentLogs(contactId = null) {
  await log('Recent Workflow Logs');

  // Get recent workflow runs
  let query = supabase
    .from('workflow_runs')
    .select(`
      id, status, triggered_by, started_at, completed_at, error_message,
      workflow_templates(name, slug)
    `)
    .order('created_at', { ascending: false })
    .limit(5);

  if (contactId) {
    query = query.eq('entity_id', contactId);
  }

  const { data: runs } = await query;

  if (!runs || runs.length === 0) {
    console.log('No workflow runs found.');
    return;
  }

  for (const run of runs) {
    console.log(`\n--- Run: ${run.workflow_templates?.name || 'Unknown'} ---`);
    console.log(`Status: ${run.status}`);
    console.log(`Started: ${run.started_at}`);
    console.log(`Completed: ${run.completed_at || 'N/A'}`);
    if (run.error_message) {
      console.log(`Error: ${run.error_message}`);
    }

    // Get step logs
    const { data: logs } = await supabase
      .from('workflow_run_logs')
      .select('step_order, step_name, status, error_message')
      .eq('workflow_run_id', run.id)
      .order('step_order');

    if (logs && logs.length > 0) {
      console.log('\nSteps:');
      logs.forEach(l => {
        const statusIcon = l.status === 'completed' ? '✓' : l.status === 'skipped' ? '○' : '✗';
        console.log(`  ${statusIcon} ${l.step_order}. ${l.step_name} [${l.status}]`);
        if (l.error_message) {
          console.log(`     Error: ${l.error_message}`);
        }
      });
    }
  }
}

async function showRateLimits() {
  await log('Rate Limit Status');

  const { data } = await supabase
    .from('rate_limit_status')
    .select('*');

  if (data && data.length > 0) {
    console.table(data);
  } else {
    console.log('No rate limit data yet.');
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  console.log('\n' + '='.repeat(60));
  console.log('  HEADLESS CRM - Workflow Test Script');
  console.log('='.repeat(60));

  if (args.includes('--emit-only')) {
    await testEmitOnly();
  } else if (args.includes('--process-pending')) {
    await testProcessPending();
  } else if (args.includes('--trigger')) {
    const idx = args.indexOf('--trigger');
    const slug = args[idx + 1] || 'intake_agent';
    await testTriggerWorkflow(slug);
  } else if (args.includes('--check-logs')) {
    await showRecentLogs();
  } else if (args.includes('--rate-limits')) {
    await showRateLimits();
  } else if (args.includes('--check')) {
    await checkCredentials();
    await checkWorkflows();
  } else {
    // Full test
    await testFullPipeline();
  }

  console.log('\n[Done]');
  process.exit(0);
}

main().catch(e => {
  console.error('[Fatal Error]', e);
  process.exit(1);
});
