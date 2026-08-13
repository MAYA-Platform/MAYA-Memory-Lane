#!/usr/bin/env python3
"""U9 (2026-08-04, Honcho-deriver pattern): derived conclusions pass.

Reads the extracted facts across ALL blocks in a library and synthesizes
cross-session derived conclusions (e.g. "User prefers budget travel",
"User's car has recurring GPS issues") into a `derived:` section on each block
or a shared derived summary. This is Honcho's "background reasoning" —
conclusions drawn from multiple observations, not just explicit facts.

Usage:
  python derive_conclusions.py --lib <library_dir> [--backend merge] [--items N]

Writes derived conclusions into each block's frontmatter as
`derived_conclusions:` (comma-joined) and a `DERIVED.md` summary at the
library root. Does NOT re-extract facts — only synthesizes from existing ones.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_backend as L

BENCH = Path(__file__).resolve().parent.parent

DERIVE_PROMPT = """You are synthesizing durable conclusions about a user from their extracted memory facts. The facts come from many conversations over time. Draw cross-session conclusions that:
- Combine facts across sessions (e.g. multiple travel mentions → "User travels frequently and prefers budget options")
- Identify stable preferences, recurring themes, relationships, lifestyle patterns
- Note changes over time (e.g. "User switched from iOS to Android in March")
- Are NOT restatements of a single fact — they must synthesize 2+ facts

Output ONLY a numbered list of concise conclusions, no preamble, no commentary.

FACTS (from all sessions):
{facts}

CONCLUSIONS:
1. """


def ollama_prompt(prompt, backend, model, max_tokens=4000):
    # merge backend uses its configured default model — pass None so llm_backend
    # resolves it, avoiding the "openai/qwen2.5:3b" prefixed-name 404.
    # max_tokens 4000: v4-pro thinking burns output budget on reasoning before
    # answering; 1500 returned empty content on long synthesis prompts.
    model_arg = None if backend == "merge" else model
    out, cost = L.strip_cost(L.llm_call(prompt, backend=backend, model=model_arg, max_tokens=max_tokens))
    return out, cost


def parse_list(out):
    items = []
    for line in out.splitlines():
        line = re.sub(r'^\s*(?:\d+[.)]|[-*•])\s*', '', line).strip()
        if len(line) > 12 and not line.lower().startswith(("we are", "let's", "here", "the facts", "based on")):
            items.append(line)
    return items[:15]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lib", default=str(BENCH / "libraries" / "ml-lane-f-facts"))
    ap.add_argument("--backend", default="local", choices=["local", "merge"])
    ap.add_argument("--model", default="qwen2.5:3b")
    ap.add_argument("--limit-facts", type=int, default=200, help="max facts to feed the deriv er")
    args = ap.parse_args()

    lib_dir = Path(args.lib)
    manifest = json.loads((lib_dir / "MANIFEST.json").read_text(encoding="utf-8"))

    # Collect all facts across blocks
    all_facts = []
    for entry in manifest["blocks"]:
        bfile = lib_dir / "shelves" / entry["shelf"] / (entry.get("filename") or f"block-{entry['lib_id']:03d}.md")
        if not bfile.exists():
            continue
        raw = bfile.read_text(encoding="utf-8")
        m = raw.split("## Extracted facts", 1)
        if len(m) < 2:
            continue
        for line in m[1].splitlines():
            line = line.strip().lstrip("-• ").strip()
            if len(line) > 10:
                all_facts.append(line)
        if len(all_facts) >= args.limit_facts:
            break

    print(f"collected {len(all_facts)} facts from {len(manifest['blocks'])} blocks")
    if not all_facts:
        print("no facts found — run auto_extract_facts.py first")
        return

    facts_text = "\n".join(f"- {f}" for f in all_facts[: args.limit_facts])
    out, cost = ollama_prompt(DERIVE_PROMPT.format(facts=facts_text), args.backend, args.model)
    if out.startswith("__ERROR__") or not out:
        print("derive failed:", out[:100])
        return
    conclusions = parse_list(out)
    print(f"derived {len(conclusions)} conclusions (cost ${cost or 0:.6f})")
    for c in conclusions:
        print("  -", c[:90])

    # Write DERIVED.md at library root
    derived_path = lib_dir / "DERIVED.md"
    derived_path.write_text(
        "# Derived Conclusions (U9 background reasoning pass)\n\n"
        + "\n".join(f"- {c}" for c in conclusions)
        + f"\n\n---\nGenerated from {len(all_facts)} facts across {len(manifest['blocks'])} blocks "
        + f"(backend={args.backend}).\n",
        encoding="utf-8",
    )
    print(f"wrote {derived_path}")


if __name__ == "__main__":
    main()
