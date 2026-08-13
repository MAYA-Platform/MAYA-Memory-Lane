#!/usr/bin/env python3
"""Auto fact-extraction — the "automatic functionality" pipeline.

For each session block in a Memory Lane library, a local LLM reads the
transcript and extracts durable facts (preferences, decisions, events,
ownership, timeline items) into a `facts:` section appended to the block.
FTS5 then indexes the facts, so natural-language queries match the extracted
facts instead of burying them in raw transcript.

This turns Memory Lane from a raw transcript store into a fact-aware memory:
the analog of what we do manually with block logic, automated.

Usage:
  python auto_extract_facts.py [--items N] [--out LIB_DIR] [--model qwen3:4b]

The extraction writes a NEW library (blocks + facts) so the original is
untouched. Re-run recall against the enriched library to measure the delta.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_backend as L

BENCH = Path(__file__).resolve().parent.parent

# U3+U5+U8 prompt (2026-08-04, Mem0/Honcho-derived): temporal grounding to
# absolute dates, ADD-only accumulation, dedup awareness, entity extraction.
FACT_PROMPT = """Extract durable facts about the user from this transcript. Output ONLY a numbered list of concise facts, no preamble, no commentary.

RULES:
- Include preferences, decisions, events with dates, owned items and their status, plans, relationships, opinions.
- RESOLVE ALL RELATIVE TIME REFERENCES TO ABSOLUTE DATES using the Observation Date: "yesterday" → the day before it, "last week" → the week preceding it, "recently" → shortly before it, "today"/"just finished" → on or near it. "User went to Paris last week" is useless later; "User went to Paris the week of May 15, 2023" is meaningful forever. Always ground relative references.
- Extract from BOTH user and assistant messages. Assistant recommendations are "User was recommended X". Extract incidental facts hidden inside requests (e.g. "I just started reading 'The Nightingale'" → extract the book-start fact).
- Do NOT re-extract facts already captured in the RECENT FACTS list below (dedup). If new info updates an existing fact, add the updated version with its date.
- Skip: greetings, filler, vague acknowledgments, assistant meta-commentary.
- When in doubt, extract — a slightly redundant fact is cheaper than a missing one.

OBSERVATION DATE: {obs_date}

RECENT FACTS (already captured, do not duplicate):
{recent_facts}

TRANSCRIPT:
{transcript}

FACTS:
1. """


# U5 (2026-08-04, Mem0-derived): entity extraction for linking/boost.
ENTITY_PROMPT = """List the named entities mentioned in this transcript about the user's life. Entities are: people (by name or relation), brands, products, places, pets, organizations, specific items owned.

Output ONLY a comma-separated list of entity names, no numbering, no commentary. Example: "Honda Civic, Yellowstone, Samsung Galaxy S22, mom"

TRANSCRIPT:
{transcript}

ENTITIES:"""


def extract_entities(transcript, model, backend="local", max_entities=12):
    """Run LLM entity extraction. Returns list of entity strings."""
    out, _ = L.strip_cost(L.llm_call(ENTITY_PROMPT.format(transcript=transcript[:4000]), backend=backend, model=model, max_tokens=800))
    if out.startswith("__ERROR__"):
        return []
    entities = [e.strip().strip('"').strip("'") for e in out.replace("\n", ",").split(",")]
    entities = [e for e in entities if len(e) >= 2 and not e.lower().startswith(("none", "the entities", "here"))]
    return entities[:max_entities]


def ollama(prompt, model, timeout=300):
    payload = json.dumps({"model": model, "prompt": prompt, "stream": False, "think": False})
    try:
        p = subprocess.run(
            ["curl", "-s", "--max-time", str(timeout), OLLAMA, "-d", payload],
            capture_output=True, text=True, timeout=timeout + 20)
        d = json.loads(p.stdout)
        return d.get("response", "").strip()
    except Exception as e:
        return f"__ERROR__ {e}"


def extract_facts(transcript, model, backend="local", obs_date=None, recent_facts=None):
    """Run LLM fact extraction. Returns list of fact strings."""
    obs_date = obs_date or "unknown (not provided)"
    recent = "\n".join(f"- {f}" for f in (recent_facts or [])[:15]) or "- (none yet)"
    prompt = FACT_PROMPT.format(transcript=transcript[:5000], obs_date=obs_date, recent_facts=recent)
    # max_tokens 1500: long extraction prompts with thinking models burn the
    # output budget on reasoning first — 600 was returning empty content.
    out, _ = L.strip_cost(L.llm_call(prompt, backend=backend, model=model, max_tokens=1500))
    if out.startswith("__ERROR__"):
        return []
    facts = []
    for line in out.splitlines():
        # strip leading numbering (1., 2., - , *, •)
        line = re.sub(r'^\s*(?:\d+[.)]|[-*•])\s*', '', line).strip()
        if len(line) > 8 and not line.lower().startswith(("we are", "let's go", "here are", "the user mentions", "fact:", "i will")):
            facts.append(line)
    return facts[:20]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", type=int, default=10, help="number of questions to enrich (their sessions)")
    ap.add_argument("--out", default=str(BENCH / "libraries" / "ml-lane-f-facts"))
    ap.add_argument("--model", default="qwen2.5:3b")
    ap.add_argument("--backend", default="local", choices=["local", "merge"], help="LLM backend: local (Ollama) or merge (main provider)")
    ap.add_argument("--entities", action="store_true", help="U5: also extract entities into frontmatter")
    ap.add_argument("--dataset", default=str(BENCH / "datasets" / "longmemeval_oracle.json"))
    ap.add_argument("--src", default=str(BENCH / "libraries" / "ml-lane-f"))
    args = ap.parse_args()

    dataset = json.loads(Path(args.dataset).read_text(encoding="utf-8"))[: args.items]
    src = Path(args.src)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # Copy source library structure to out, then enrich blocks with facts.
    import shutil
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(src, out)

    # Collect the session_ids we need to enrich (all haystack sessions for the selected questions)
    session_ids = set()
    for inst in dataset:
        session_ids.update(inst["haystack_session_ids"])
    print(f"enriching {len(session_ids)} sessions across {len(dataset)} questions")

    # Map block file -> session_id by reading frontmatter
    enriched = 0
    errors = 0
    t0 = time.time()
    accumulated_facts = {}  # session_id -> [recent facts] for U8 dedup
    manifest_path = out / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    for entry in manifest["blocks"]:
        bfile = out / "shelves" / entry["shelf"] / (entry.get("filename") or f"block-{entry['lib_id']:03d}.md")
        if not bfile.exists():
            continue
        raw = bfile.read_text(encoding="utf-8")
        m = raw.split("---", 2)
        if len(m) < 3:
            continue
        fm, body = m[1], m[2]
        sid_match = None
        for line in fm.splitlines():
            if line.startswith("session_id:"):
                sid_match = line.split(":", 1)[1].strip()
                break
        if sid_match not in session_ids:
            continue
        # extract facts from the body (U3: temporal grounding via obs_date,
        # U8: dedup against recently-extracted facts for this session)
        transcript = body.strip()
        if len(transcript) < 40:
            continue
        # find observation date from frontmatter (created_at / date / timestamp)
        obs_date = None
        for line in fm.splitlines():
            if line.startswith(("created_at:", "date:", "timestamp:", "obs_date:")):
                obs_date = line.split(":", 1)[1].strip().strip('"').strip("'")
                break
        recent = accumulated_facts.get(sid_match, [])
        facts = extract_facts(transcript, None if args.backend == "merge" else args.model, args.backend, obs_date=obs_date, recent_facts=recent)
        entities = extract_entities(transcript, None if args.backend == "merge" else args.model, args.backend) if args.entities else []
        if facts:
            accumulated_facts[sid_match] = (recent + facts)[-20:]  # keep last 20 for dedup
            # append facts section to the block body, recompute hash, update manifest
            facts_text = "\n".join(f"- {f}" for f in facts)
            new_body = f"{body.rstrip()}\n\n## Extracted facts\n\n{facts_text}\n"
            # U5: add entities to frontmatter for entity-linking boost
            entities_line = f"entities: {', '.join(entities)}\n" if entities else ""
            new_raw = f"---{fm}{entities_line}---{new_body}"
            bfile.write_text(new_raw, encoding="utf-8")
            new_sha = hashlib.sha256(new_raw.encode("utf-8")).hexdigest()
            entry["sha256"] = new_sha
            entry["facts_count"] = len(facts)
            if entities:
                entry["entities"] = entities
            enriched += 1
        else:
            errors += 1
        if (enriched + errors) % 20 == 0:
            print(f"  progress: enriched={enriched} errors={errors} elapsed={time.time()-t0:.0f}s")

    # renumber total_blocks
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nDONE: enriched {enriched} blocks, {errors} with no facts, {time.time()-t0:.0f}s elapsed")
    print(f"Enriched library: {out}")
    print(f"Next: re-run Lane A recall against {out} to measure the delta.")


if __name__ == "__main__":
    main()
