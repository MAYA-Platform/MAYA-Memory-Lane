#!/usr/bin/env node
/**
 * Memory Lane — automatic fact extraction (v3, 2026-08-05).
 *
 * Turns a raw transcript into durable, searchable facts using an LLM, then
 * hands those facts to appendBlock() so the memory is sealed onto the chain.
 *
 * Provider routing (recommended model = deepseek v4 flash via Merge Gateway):
 *
 *   1. env overrides:   MEMORY_LANE_API_KEY, MEMORY_LANE_BASE_URL,
 *                       MEMORY_LANE_MODEL
 *   2. Hermes config:   HERMES_HOME/config.yaml -> providers.merge
 *                       (api_key, base_url, default_model)
 *   3. fallback:        local Ollama (127.0.0.1:11434) when no key is set
 *
 * Graceful degradation is a hard rule: extraction failure NEVER blocks a
 * memory from being sealed. appendBlock() still runs with an empty facts
 * array, so the raw transcript is preserved and searchable either way.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendBlock } from './memoryLaneCore.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';

/**
 * Resolve the extraction backend configuration.
 * Returns { apiKey, baseUrl, model, backend } where backend is 'merge' or 'ollama'.
 */
export function resolveExtractConfig() {
  // 1. Explicit env overrides win.
  const apiKey = process.env.MEMORY_LANE_API_KEY || null;
  const baseUrl = process.env.MEMORY_LANE_BASE_URL || null;
  const model = process.env.MEMORY_LANE_MODEL || null;
  if (apiKey) {
    return {
      apiKey,
      baseUrl: baseUrl || 'https://api-gateway.merge.dev/v1/openai',
      model: model || 'deepseek/deepseek-v4-flash',
      backend: 'merge'
    };
  }

  // 2. Hermes config.yaml -> providers.merge (yaml sub-parse; flat keys only).
  try {
    const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), 'AppData', 'Local', 'hermes');
    const cfgPath = path.join(hermesHome, 'config.yaml');
    if (fs.existsSync(cfgPath)) {
      const yaml = fs.readFileSync(cfgPath, 'utf8');
      const mergeBlock = extractYamlSection(yaml, 'merge');
      const key = mergeBlock.api_key || null;
      if (key) {
        return {
          apiKey: key,
          baseUrl: mergeBlock.base_url || baseUrl || 'https://api-gateway.merge.dev/v1/openai',
          // Extraction model is pinned to deepseek v4 flash — the recommended
          // model for this pipeline (fast, cheap, plenty for fact extraction).
          // Config's default_model (v4-pro) is for Hermes general use, not here.
          model: model || 'deepseek/deepseek-v4-flash',
          backend: 'merge'
        };
      }
    }
  } catch {
    // fall through to Ollama
  }

  // 3. Local Ollama fallback — zero cost, always available.
  return { apiKey: null, baseUrl: OLLAMA_URL, model: model || 'qwen2.5:3b', backend: 'ollama' };
}

/**
 * Minimal YAML section extractor: pull the flat `key: value` lines belonging
 * to a named 2-space-indented section (e.g. `merge:` inside `providers:`).
 * Handles quoted values. Not a general YAML parser — enough for config.yaml.
 */
function extractYamlSection(yaml, sectionName) {
  const lines = yaml.split(/\r?\n/);
  const out = {};
  let inSection = false;
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent === 0) { inSection = false; continue; }
    if (indent === 2 && line.trim().startsWith(`${sectionName}:`)) { inSection = true; continue; }
    if (inSection && indent === 4) {
      const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim());
      if (m) {
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        out[m[1]] = val;
      }
    }
  }
  return out;
}

/**
 * The extraction prompt. Output contract: a numbered list of durable,
 * searchable facts. Facts are what FTS5 indexes, so the wording should
 * mirror how a user would later ask for the information.
 */
export const FACT_PROMPT = `Extract durable facts about the user from this transcript. Output ONLY a numbered list of concise facts, no preamble, no commentary.

RULES:
- Include preferences, decisions, events with dates, owned items and their status, plans, relationships, opinions.
- Write each fact as a searchable statement that includes the subject (e.g. "User owns a 2018 Honda Civic" not "owns a car").
- Keep each fact to one line, no markdown, no bullet symbols.
- Skip small talk, greetings, and transient chatter with no lasting value.
- If the transcript has no durable facts, output an empty list.

TRANSCRIPT:
`;

/**
 * Call the LLM backend to extract facts from a transcript.
 * Returns { ok, facts, error } — ok=false never throws; callers degrade.
 */
export async function extractFacts(transcript, { maxLen = 24000, timeoutMs = 120000 } = {}) {
  const cfg = resolveExtractConfig();
  const text = String(transcript || '').trim().slice(0, maxLen);
  if (!text) return { ok: true, facts: [], error: null };

  try {
    if (cfg.backend === 'merge') {
      return await extractViaMerge(cfg, text, timeoutMs);
    }
    return await extractViaOllama(cfg, text, timeoutMs);
  } catch (err) {
    return { ok: false, facts: [], error: String(err && err.message ? err.message : err) };
  }
}

async function extractViaMerge(cfg, text, timeoutMs) {
  // Up to 3 attempts: the Merge endpoint occasionally answers a prompt with a
  // tool_call instead of content (empty content, HTTP 200). A retry almost
  // always returns the fact list; tool calls are disabled up front via
  // tool_choice:'none' to make that path rare.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: 'You extract durable, searchable facts from user transcripts. Reply with plain text only, never tool calls.' },
          { role: 'user', content: FACT_PROMPT + text }
        ],
        temperature: 0.2,
        max_tokens: 800,
        tool_choice: 'none',
        tools: []
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      return { ok: false, facts: [], error: `merge HTTP ${res.status}` };
    }
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let content = (msg && msg.content) || '';
    // DeepSeek-via-Merge is a thinking model: it occasionally routes the whole
    // answer into the `thinking` field and returns content:null. Use thinking
    // as the fallback source so facts still come back.
    if (!content.trim() && msg && typeof msg.thinking === 'string' && msg.thinking.trim()) {
      content = msg.thinking;
    }
    if (content.trim()) {
      return { ok: true, facts: parseFactList(content), raw: content, model: cfg.model };
    }
    // Empty content on HTTP 200 -> tool-call emission or thinking hiccup.
    if (attempt === 2) {
      return { ok: false, facts: [], error: 'merge returned empty content after 3 attempts' };
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return { ok: false, facts: [], error: 'merge returned empty content' };
}

async function extractViaOllama(cfg, text, timeoutMs) {
  const res = await fetch(cfg.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      prompt: FACT_PROMPT + text,
      stream: false,
      think: false,
      options: { num_predict: 800 }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    return { ok: false, facts: [], error: `ollama HTTP ${res.status}` };
  }
  const data = await res.json();
  const content = data.response || '';
  return { ok: true, facts: parseFactList(content), raw: content, model: cfg.model };
}

/**
 * Parse a numbered fact list out of an LLM response. Tolerates "1. fact",
 * "1) fact", "- fact", and bare lines. Drops blank lines and any leftover
 * preamble/commentary lines (heuristic: lines that are obviously not facts).
 */
export function parseFactList(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 2 && !/^(here|the|facts|output|below|above|list|note|transcript)/i.test(l) && !/^---/.test(l));
}

/**
 * Ingest helper: extract facts then append a block. One call does the whole
 * pipeline so the CLI, server, and cron all share the same behavior.
 * Returns the appendBlock() result enriched with extraction info.
 */
export async function ingestTranscript(rootDir, {
  title = 'Memory block',
  body = '',
  source = null,
  lineage = 'auto',
  extract = true,
  facts = null
} = {}) {
  let extraction = { ok: false, facts: [], error: 'extract disabled' };
  let usedFacts = Array.isArray(facts) ? facts : [];
  if (extract) {
    extraction = await extractFacts(body);
    usedFacts = extraction.facts || [];
  }
  const result = appendBlock(rootDir, { title, body, facts: usedFacts, source, lineage });
  return { ...result, extraction };
}
