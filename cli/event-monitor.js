/**
 * Event Monitor
 *
 * Polls for unprocessed events and triggers corresponding workflows.
 * Run alongside the CLI to enable the agent pipeline.
 *
 * Usage: node event-monitor.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root FIRST
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Dynamic imports after env is loaded
const { supabase } = await import('./supabase.js');
const { processPendingEvents } = await import('./workflow-executor.js');

// Configuration
const POLL_INTERVAL_MS = 5000; // Check every 5 seconds
const BATCH_SIZE = 10;

let isProcessing = false;
let eventCount = 0;

async function pollEvents() {
  if (isProcessing) return;

  isProcessing = true;
  try {
    // Check for events that are ready to process (delay_until has passed)
    const { data: events, error } = await supabase
      .from('events')
      .select('*')
      .eq('processed', false)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      console.error(`[Monitor] Error fetching events: ${error.message}`);
      return;
    }

    if (events && events.length > 0) {
      // Filter events whose delay has passed
      const readyEvents = events.filter(e => {
        if (!e.payload?.delay_until) return true;
        return new Date(e.payload.delay_until) <= new Date();
      });

      if (readyEvents.length > 0) {
        console.log(`\n[Monitor] Processing ${readyEvents.length} event(s)...`);

        for (const event of readyEvents) {
          eventCount++;
          console.log(`[Monitor] #${eventCount} ${event.event_type} for ${event.entity_type}:${event.entity_id}`);

          try {
            const result = await processPendingEvents(1);
            if (result.results?.[0]?.success) {
              console.log(`[Monitor] ✓ Workflow completed`);
            } else if (result.results?.[0]?.error) {
              console.log(`[Monitor] ✗ Workflow error: ${result.results[0].error}`);
            } else {
              console.log(`[Monitor] - No matching workflow found`);
            }
          } catch (err) {
            console.error(`[Monitor] Error processing event: ${err.message}`);
          }
        }
      }
    }
  } finally {
    isProcessing = false;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     CRM Event Monitor Started          ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║ Polling every ${POLL_INTERVAL_MS / 1000}s for new events...    ║`);
  console.log('║ Press Ctrl+C to stop                   ║');
  console.log('╚════════════════════════════════════════╝\n');

  // Initial poll
  await pollEvents();

  // Start polling loop
  setInterval(pollEvents, POLL_INTERVAL_MS);
}

main().catch(console.error);
