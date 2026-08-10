#!/usr/bin/env python3
"""Distiller — the LLM-gated synthesis pass for the Auto-Observation pipeline.

Reads the observation ledger (observations.jsonl) from a Memory Lane library
plus the extracted facts across blocks, and synthesizes:

  1. derived conclusions (cross-session patterns: "user prefers X",
     "car has recurring GPS issues")  — Honcho's "background reasoning"
  2. a compact PROFILE_SNAPSHOT.md (peer-card equivalent) — the drop-in
     injection contract for the hosted service

This is the "Distiller" stage of Observer → Store → Distiller → Injector.
Runs on the merge (DeepSeek via Merge) or local (Ollama) backend.

Usage:
  python distill_observations.py --lib <library_dir> [--backend merge|local]
                                 [--model qwen2.5:3b] [--max-obs 400]

Writes:
  DERIVED.md            — derived conclusions (list)
  PROFILE_SNAPSHOT.md   — compact profile snapshot for injection
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_backend as L

DERIVE_PROMPT = """You are synthesizing durable conclusions about a user from their captured observations and extracted memory facts. The observations come from many conversations over time.

Draw cross-session conclusions that:
- Combine signals across sessions (e.g. multiple travel mentions → "User travels frequently and prefers budget options")
- Identify stable preferences, recurring themes, relationships, lifestyle patterns, projects
- Note changes over time (e.g. "User switched from iOS to Android in March")
- Are NOT restatements of a single observation — they must synthesize 2+ signals
- ABSTAIN (write "NONE") if the signals are too thin or contradictory — a wrong conclusion is worse than no conclusion

Output ONLY a numbered list of concise conclusions, no preamble, no commentary.

OBSERVATIONS:
{observations}

FACTS:
{facts}

CONCLUSIONS:
1. """

PROFILE_PROMPT = """You are writing a compact profile snapshot for a user, the local equivalent of a memory-service peer card. This will be injected at the start of a session so the assistant resumes with context.

Write 5-8 short lines covering: who they are (role/identity), active projects, stable preferences, key decisions, boundaries/instructions, and anything time-sensitive.

Be concrete and grounded in the observations. If a category has no evidence, omit it. Do NOT invent.

OBSERVATIONS:
{observations}

DERIVED CONCLUSIONS:
{derived}

PROFILE SNAPSHOT:
- """


def parse_list(out):
    if not out or out.strip().upper() in ("NONE", "NONE."):
        return []
    items = []
    for line in out.splitlines():
        line = re.sub(r'^\s*(?:\d+[.)]|[-*•])\s*', '', line).strip()
        if len(line) > 12 and not line.lower().startswith(("we are", "let's", "here", "based on", "the observations")):
            items.append(line)
    return items[:15]


def load_observations(lib_dir: Path):
    obs_file = lib_dir / "observations.jsonl"
    if not obs_file.exists():
        return []
    out = []
    for line in obs_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
            out.append(f"[{o.get('cls','?')}] {o.get('excerpt','')[:200]}")
        except json.JSONDecodeError:
            continue
    return out


def load_facts(lib_dir: Path, limit=300):
    manifest_file = lib_dir / "MANIFEST.json"
    if not manifest_file.exists():
        return []
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    facts = []
    for entry in manifest.get("blocks", []):
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
                facts.append(line)
        if len(facts) >= limit:
            break
    return facts[:limit]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lib", default=str(Path(__file__).resolve().parent.parent / "libraries" / "ml-lane-a"))
    ap.add_argument("--backend", default="merge", choices=["local", "merge"])
    ap.add_argument("--model", default="qwen2.5:3b")
    ap.add_argument("--max-obs", type=int, default=400)
    args = ap.parse_args()

    lib_dir = Path(args.lib)
    obs = load_observations(lib_dir)
    facts = load_facts(lib_dir)
    print(f"observations: {len(obs)}, facts: {len(facts)}")
    if not obs:
        print("no observations — run the Observer over the library first")
        return

    obs_text = "\n".join(f"- {o}" for o in obs[-args.max_obs:])
    facts_text = "\n".join(f"- {f}" for f in facts) or "- (none)"

    # Stage 1: derive conclusions
    model_arg = None if args.backend == "merge" else args.model
    out, cost = L.strip_cost(L.llm_call(
        DERIVE_PROMPT.format(observations=obs_text, facts=facts_text),
        backend=args.backend, model=model_arg, max_tokens=4000,
    ))
    conclusions = parse_list(out)
    print(f"derived {len(conclusions)} conclusions (cost ${cost or 0:.6f})")
    for c in conclusions:
        print("  -", c[:90])

    # Stage 2: profile snapshot
    out2, cost2 = L.strip_cost(L.llm_call(
        PROFILE_PROMPT.format(observations=obs_text, derived="\n".join(f"- {c}" for c in conclusions) or "- (none)"),
        backend=args.backend, model=model_arg, max_tokens=1500,
    ))
    profile_lines = [l.strip().lstrip("-• ").strip() for l in out2.splitlines() if l.strip()]
    print(f"profile lines: {len(profile_lines)} (cost ${cost2 or 0:.6f})")

    # Write outputs
    (lib_dir / "DERIVED.md").write_text(
        "# Derived Conclusions (Distiller pass)\n\n"
        + ("\n".join(f"- {c}" for c in conclusions) if conclusions else "- (none — insufficient signal)")
        + f"\n\n---\nGenerated from {len(obs)} observations + {len(facts)} facts (backend={args.backend}).\n",
        encoding="utf-8",
    )
    (lib_dir / "PROFILE_SNAPSHOT.md").write_text(
        "# Profile Snapshot\n\n"
        + "\n".join(f"- {l}" for l in profile_lines)
        + f"\n\n---\nGenerated from {len(obs)} observations (backend={args.backend}).\n",
        encoding="utf-8",
    )
    print(f"wrote {lib_dir / 'DERIVED.md'}")
    print(f"wrote {lib_dir / 'PROFILE_SNAPSHOT.md'}")


if __name__ == "__main__":
    main()
