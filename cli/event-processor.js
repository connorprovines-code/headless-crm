/**
 * Native Event Processor
 *
 * Uses Supabase Realtime to listen for events and process them instantly.
 * This runs as part of the main CLI - no separate daemon needed.
 *
 * Architecture:
 * - Subscribes to INSERT events on the `events` table via WebSocket
 * - Each new event triggers the appropriate workflow
 * - Multiple agents can register listeners for different event types
 * - Graceful handling of connection drops with auto-reconnect
 */

import { supabase } from './supabase.js';
import { processEvent } from './workflow-executor.js';

// ============================================================================
// STATE
// ============================================================================

let channel = null;
let isConnected = false;
let eventCount = 0;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 3000;

// Event type handlers (agents register here)
const eventHandlers = new Map();

// Pending events queue (for events that arrive before handlers register)
const pendingQueue = [];

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Start the event processor - call this when CLI boots
 */
export async function startEventProcessor() {
  if (isConnected) {
    console.log('[EventProcessor] Already running');
    return;
  }

  console.log('[EventProcessor] Starting native event processor...');

  await connect();

  // Process any events that were queued while system was down
  await processBacklog();

  return {
    stop: stopEventProcessor,
    status: getStatus,
    registerHandler,
    unregisterHandler,
  };
}

/**
 * Stop the event processor gracefully
 */
export async function stopEventProcessor() {
  if (channel) {
    console.log('[EventProcessor] Shutting down...');
    await supabase.removeChannel(channel);
    channel = null;
    isConnected = false;
    console.log('[EventProcessor] Stopped');
  }
}

/**
 * Register a handler for a specific event type
 * Agents call this to subscribe to their trigger events
 */
export function registerHandler(eventType, handler, options = {}) {
  if (!eventHandlers.has(eventType)) {
    eventHandlers.set(eventType, []);
  }

  eventHandlers.get(eventType).push({
    handler,
    priority: options.priority || 0,
    name: options.name || 'anonymous',
  });

  // Sort by priority (higher first)
  eventHandlers.get(eventType).sort((a, b) => b.priority - a.priority);

  console.log(`[EventProcessor] Registered handler for: ${eventType} (${options.name || 'anonymous'})`);
}

/**
 * Unregister a handler
 */
export function unregisterHandler(eventType, handler) {
  if (eventHandlers.has(eventType)) {
    const handlers = eventHandlers.get(eventType);
    const index = handlers.findIndex(h => h.handler === handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }
}

/**
 * Get current status
 */
export function getStatus() {
  return {
    connected: isConnected,
    eventsProcessed: eventCount,
    registeredEventTypes: Array.from(eventHandlers.keys()),
    pendingQueueSize: pendingQueue.length,
  };
}

// ============================================================================
// INTERNAL FUNCTIONS
// ============================================================================

/**
 * Connect to Supabase Realtime
 */
async function connect() {
  try {
    channel = supabase
      .channel('events-processor')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'events',
        },
        handleNewEvent
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          isConnected = true;
          reconnectAttempts = 0;
          console.log('[EventProcessor] Connected to Realtime');
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          isConnected = false;
          console.log(`[EventProcessor] Connection ${status}, attempting reconnect...`);
          attemptReconnect();
        }
      });
  } catch (error) {
    console.error('[EventProcessor] Connection error:', error.message);
    attemptReconnect();
  }
}

/**
 * Handle reconnection with exponential backoff
 */
async function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[EventProcessor] Max reconnect attempts reached. Manual restart required.');
    return;
  }

  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);

  console.log(`[EventProcessor] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

  setTimeout(async () => {
    if (channel) {
      await supabase.removeChannel(channel);
    }
    await connect();
  }, delay);
}

/**
 * Handle incoming event from Realtime
 */
async function handleNewEvent(payload) {
  const event = payload.new;

  if (!event || event.processed) {
    return;
  }

  eventCount++;

  // Check for delay_until
  if (event.payload?.delay_until) {
    const delayUntil = new Date(event.payload.delay_until);
    const now = new Date();

    if (delayUntil > now) {
      const waitMs = delayUntil - now;
      console.log(`[EventProcessor] Event ${event.event_type} delayed ${Math.ceil(waitMs / 1000)}s`);

      // Schedule processing after delay
      setTimeout(() => processEventWithHandlers(event), waitMs);
      return;
    }
  }

  await processEventWithHandlers(event);
}

/**
 * Process an event through registered handlers and workflow executor
 */
async function processEventWithHandlers(event) {
  const { event_type, entity_type, entity_id } = event;

  console.log(`[EventProcessor] Processing: ${event_type} for ${entity_type}:${entity_id?.slice(0, 8)}...`);

  // Check for custom handlers first
  if (eventHandlers.has(event_type)) {
    const handlers = eventHandlers.get(event_type);

    for (const { handler, name } of handlers) {
      try {
        console.log(`[EventProcessor] Running handler: ${name}`);
        await handler(event);
      } catch (error) {
        console.error(`[EventProcessor] Handler ${name} error:`, error.message);
      }
    }
  }

  // Always run through workflow executor for database-defined workflows
  try {
    const result = await processEvent(event);

    if (result.workflows_run > 0) {
      console.log(`[EventProcessor] Completed ${result.workflows_run} workflow(s)`);
    }
  } catch (error) {
    console.error(`[EventProcessor] Workflow error:`, error.message);
  }
}

/**
 * Process any unprocessed events from before startup
 */
async function processBacklog() {
  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('processed', false)
    .order('created_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error('[EventProcessor] Failed to fetch backlog:', error.message);
    return;
  }

  if (events && events.length > 0) {
    console.log(`[EventProcessor] Processing ${events.length} backlogged event(s)...`);

    for (const event of events) {
      await processEventWithHandlers(event);
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  startEventProcessor,
  stopEventProcessor,
  registerHandler,
  unregisterHandler,
  getStatus,
};
