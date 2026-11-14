#!/usr/bin/env python3
"""Recompute explicitly named metrics from existing Lane A JSONL; no providers.

This is not the official LongMemEval NDCG: existing logs omit the full
corpus relevance vector needed by the official implementation.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path


def summarize(rows, cutoffs=(5, 10)):
    if not isinstance(rows, list) or not rows:
        raise ValueError('nonempty rows required')
    selected, seen = [], set()
    excluded = 0
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('row must be an object')
        qid = row.get('question_id')
        if not isinstance(qid, str) or not qid or qid in seen:
            raise ValueError('question IDs must be unique nonempty strings')
        seen.add(qid)
        if '_abs' in qid:
            excluded += 1
            continue
        gold, retrieved = row.get('gold_sessions'), row.get('retrieved_sessions')
        if (not isinstance(gold, list) or not gold or not isinstance(retrieved, list)
                or any(not isinstance(x, str) or not x for x in gold + retrieved)):
            raise ValueError('non-abstention row has invalid gold or retrieved IDs')
        selected.append((qid, gold, retrieved))
    if not selected:
        raise ValueError('no scorable questions')
    result = {'rows_total': len(rows), 'excluded_abs': excluded, 'rows_scored': len(selected),
              'rows_with_duplicate_retrieved_ids': sum(len(r) != len(set(r)) for _, _, r in selected),
              'metrics': {}}
    if all(isinstance(row.get('question'), str) for row in rows):
        inputs = [(row['question_id'], row['question'], row.get('gold_sessions')) for row in rows]
        encoded = json.dumps(inputs, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        result['ordered_inputs_sha256'] = hashlib.sha256(encoded).hexdigest()
    for k in cutoffs:
        if not isinstance(k, int) or isinstance(k, bool) or k < 1:
            raise ValueError('invalid cutoff')
        all_gold = first_hit = 0.0
        for _, gold, ranked in selected:
            top = ranked[:k]
            all_gold += float(all(g in set(top) for g in gold))
            first = next((i for i, item in enumerate(top) if item in set(gold)), None)
            first_hit += 0.0 if first is None else 1 / math.log2(first + 2)
        result['metrics'][str(k)] = {'all_gold_recall': all_gold / len(selected),
                                      'custom_first_hit_log2': first_hit / len(selected)}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('logs', nargs='+', type=Path, help='existing Lane A JSONL traces')
    args = parser.parse_args()
    reports = []
    for file in args.logs:
        data = file.read_bytes()
        rows = [json.loads(line) for line in data.decode('utf-8').splitlines() if line.strip()]
        report = summarize(rows)
        report.update({'file': file.name, 'sha256': hashlib.sha256(data).hexdigest()})
        reports.append(report)
    print(json.dumps({'schema': 'lane-a-audit-v1', 'official_ndcg_recomputed': False,
                      'duplicate_positions_preserved': True, 'reports': reports}, indent=2))


if __name__ == '__main__':
    main()
