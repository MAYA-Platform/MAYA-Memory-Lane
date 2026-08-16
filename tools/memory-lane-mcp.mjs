#!/usr/bin/env node
/**
 * Memory Lane — MCP bridge (v1, 2026-08-05).
 *
 * Exposes the Memory Lane live library to any MCP-capable agent (
 * crons) as callable tools over the Model Context Protocol (stdio). This is
 * the READ path that makes the library a real-time agent upgrade instead of
 * a write-only vault:
 *
 *   ml_search(query)     — full-text search across all blocks
 *   ml_answer(question)  — ask your memory (direct / synthesized / none)
 *   ml_recent(limit)     — digest of the most recent blocks (session start)
 *   ml_resume(phrase)    — resolve a resume phrase
 *
 * Zero dependencies: pure stdio JSON-RPC 2.0 over stdin/stdout, reusing the
 * existing lib (memoryLaneCore + answer). The library path comes from
 * MEMORY_LANE_LIBRARY or defaults to the live library.
 *
 * Register with any MCP-capable agent (example uses the Hermes CLI):
 *   <agent> mcp add memory-lane --command node \
 *     --args "E:/MAYA_BULK/memory-lane-public-repo/tools/memory-lane-mcp.mjs"
 *
 * Manual smoke test:
 *   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node memory-lane-mcp.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadLibrary, search, resolveResume, readBlock } from '../lib/memoryLaneCore.js';
import { answerQuestion } from '../lib/answer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY = process.env.MEMORY_LANE_LIBRARY || 'E:/MAYA_BULK/memory-lane-live';

const TOOLS = [
  {
    name: 'ml_search',
    description: 'Search the Memory Lane library (your persistent memory). Returns matching blocks with excerpts. Use when the user references past decisions, people, projects, or asks about something that may have been discussed before.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms, e.g. "honda civic" or "launch timeline"' },
        limit: { type: 'number', description: 'Max results (default 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'ml_answer',
    description: 'Ask your memory a natural-language question. Returns an answer (exact match, or synthesized from retrieved evidence by a model). Use when the user asks something that your memory might answer better than guessing: "what did we decide about X", "when is Y", "who is Z".',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask your memory' }
      },
      required: ['question']
    }
  },
  {
    name: 'ml_recent',
    description: 'Get a digest of the most recent memory blocks. Call this at the START of a session to load relevant context about what has been worked on recently before responding.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of recent blocks (default 5)' }
      }
    }
  },
  {
    name: 'ml_resume',
    description: 'Resolve a resume phrase to the block(s) it points at. Use when the user gives a resume phrase or references a continuity block by id.',
    inputSchema: {
      type: 'object',
      properties: {
        phrase: { type: 'string', description: 'Resume phrase or block id, e.g. "cb_session_aug5_0060" or "block logic resume"' }
      },
      required: ['phrase']
    }
  }
];

function getLibrary() {
  const lib = loadLibrary(LIBRARY);
  return lib.ok ? lib : null;
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const EXCERPT_CHARS = 320;

/**
 * Extract a short, high-signal content digest from a block so callers get the
 * meaning of a block, not just its title. Prefers a Current State / Established
 * Claims / Decisions section when present, else falls back to leading body text.
 * Bounded to EXCERPT_CHARS so ml_recent stays cheap.
 */
function excerptBlock(lib, block) {
  try {
    const full = readBlock(lib, block.lib_id);
    if (!full || !full.present || !full.body) return '';
    const body = full.body;
    const section = /## (Current State|Established Claims|Decisions)\s*\n([\s\S]*?)(?=\n## |\n# |$)/i.exec(body);
    const text = section ? section[2].trim() : body.replace(/^#.*$/gm, '').trim();
    if (!text) return '';
    if (text.length <= EXCERPT_CHARS) return text;
    const cut = text.slice(0, EXCERPT_CHARS);
    return cut.slice(0, cut.lastIndexOf(' ')) + '…';
  } catch {
    return '';
  }
}

async function handleToolCall(name, args) {
  const lib = getLibrary();
  if (!lib) return { isError: true, content: [{ type: 'text', text: `Memory Lane library not found at ${LIBRARY}` }] };

  switch (name) {
    case 'ml_search': {
      const q = String((args && args.query) || '');
      const limit = Number((args && args.limit) || 5);
      if (!q) return { isError: true, content: [{ type: 'text', text: 'query is required' }] };
      const r = search(lib, q, { limit });
      if (!r.count) return { content: [{ type: 'text', text: `No matches for "${q}".` }] };
      const lines = r.matches.map((m) => `• ${m.block_id} — ${esc(m.excerpt.slice(0, 200))}`);
      return { content: [{ type: 'text', text: `${r.count} match(es) for "${q}":\n${lines.join('\n')}` }] };
    }
    case 'ml_answer': {
      const q = String((args && args.question) || '');
      if (!q) return { isError: true, content: [{ type: 'text', text: 'question is required' }] };
      const r = await answerQuestion(lib, q);
      const modeTag = r.mode === 'direct' ? '[exact match]' : r.mode === 'synthesized' ? '[synthesized from memory]' : '[no memory]';
      const source = r.source ? `\nSource: ${r.source}` : (r.evidence && r.evidence.length ? `\nEvidence: ${r.evidence.slice(0, 2).map((e) => e.block_id).join(', ')}` : '');
      return { content: [{ type: 'text', text: `${modeTag} ${esc(r.answer)}${source}` }] };
    }
    case 'ml_recent': {
      const limit = Number((args && args.limit) || 5);
      const recent = lib.blocks.slice(-limit).reverse();
      if (!recent.length) return { content: [{ type: 'text', text: 'Library is empty.' }] };
      const lines = recent.map((b) => {
        const excerpt = excerptBlock(lib, b);
        const title = `• ${b.block_id} (lib ${b.lib_id}) — ${esc(b.canonical_name || b.block_id)}`;
        return excerpt ? `${title}\n  ${esc(excerpt)}` : title;
      });
      return { content: [{ type: 'text', text: `Most recent memory blocks:\n${lines.join('\n')}` }] };
    }
    case 'ml_resume': {
      const p = String((args && args.phrase) || '');
      if (!p) return { isError: true, content: [{ type: 'text', text: 'phrase is required' }] };
      const r = resolveResume(lib, p);
      if (!r.found) return { content: [{ type: 'text', text: `No block matches resume phrase "${p}".` }] };
      const lines = r.blocks.map((b) => {
        const excerpt = excerptBlock(lib, b);
        const title = `• ${b.block_id} (lib ${b.lib_id}) — ${esc(b.canonical_name || '')}`;
        return excerpt ? `${title}\n  ${esc(excerpt)}` : title;
      });
      return { content: [{ type: 'text', text: `Resume phrase found:\n${lines.join('\n')}` }] };
    }
    default:
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const pending = new Map();
let nextId = 1;

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    const resp = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'memory-lane-mcp', version: '1.0.0' }
      }
    };
    process.stdout.write(JSON.stringify(resp) + '\n');
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    const resp = { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
    process.stdout.write(JSON.stringify(resp) + '\n');
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    try {
      const result = await handleToolCall(name, args || {});
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { isError: true, content: [{ type: 'text', text: String(err.message || err) }] }
      }) + '\n');
    }
    return;
  }
  // Anything else: echo a pong so clients don't hang.
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
});
