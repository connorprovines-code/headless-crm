import 'dotenv/config';
import * as readline from 'readline';
import Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions, executeTool } from './tools.js';
import { SYSTEM_PROMPT, GREETING } from './prompts.js';

// Verify environment
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in environment');
  process.exit(1);
}

const anthropic = new Anthropic();
const conversationHistory = [];

// Process a single user message through Claude
async function chat(userMessage) {
  conversationHistory.push({
    role: 'user',
    content: userMessage,
  });

  // Initial API call
  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: toolDefinitions,
    messages: conversationHistory,
  });

  // Handle tool use loop
  while (response.stop_reason === 'tool_use') {
    const assistantMessage = { role: 'assistant', content: response.content };
    conversationHistory.push(assistantMessage);

    // Execute all tool calls
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        console.log(`  [Calling ${block.name}...]`);
        try {
          const result = await executeTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (error) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: error.message }),
            is_error: true,
          });
        }
      }
    }

    // Add tool results and continue
    conversationHistory.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions,
      messages: conversationHistory,
    });
  }

  // Extract final text response
  const finalText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  conversationHistory.push({
    role: 'assistant',
    content: response.content,
  });

  return finalText;
}

// Main REPL loop
async function main() {
  console.log('\n' + GREETING);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question('\n> ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      }

      try {
        const response = await chat(trimmed);
        console.log('\n' + response);
      } catch (error) {
        console.error('Error:', error.message);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
