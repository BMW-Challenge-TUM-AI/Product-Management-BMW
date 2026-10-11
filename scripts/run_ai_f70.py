"""F70 source-backed analysis runner. Preview mode never calls an external API."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.ai import run_ai_pipeline
from src.ai.adapter import load_feedback_for_ai, load_reference_inventory
from src.ai.db import DEFAULT_DB, save_run


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as stream:
        for obj in rows:
            stream.write(json.dumps(obj, ensure_ascii=False, allow_nan=False) + '\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['preview', 'live'], default='preview')
    parser.add_argument('--input', default='data/processed/feedback.jsonl')
    parser.add_argument('--country', help='Exact feedback country code')
    parser.add_argument('--limit', type=int, default=20, help='Maximum source records; use 0 for all')
    parser.add_argument('--seed', type=int, default=42, help='Sampling seed for reproducible source selection')
    parser.add_argument('--allow-external-data-transfer', action='store_true',
                        help='Confirm approval to send selected source data to the configured model provider')
    parser.add_argument('--db', default=str(DEFAULT_DB))
    args = parser.parse_args(argv)

    limit = None if args.limit == 0 else args.limit
    records, stats = load_feedback_for_ai(ROOT / args.input, country=args.country,
                                           limit=limit, seed=args.seed)
    print('SOURCE:', json.dumps(stats, ensure_ascii=False))
    print('REFERENCE INVENTORY:', json.dumps(load_reference_inventory(ROOT / 'data/processed')))
    if args.mode == 'preview':
        print('PREVIEW ONLY: no model calls, data transfer, or database changes.')
        return 0
    if not records:
        print('No eligible source records selected. Nothing to process.')
        return 1
    if not args.allow_external_data_transfer:
        parser.error('Processing source feedback requires explicit approval with --allow-external-data-transfer.')

    from dotenv import load_dotenv
    load_dotenv(ROOT / '.env')
    if not os.getenv('OPENAI_API_KEY'):
        parser.error('Missing OPENAI_API_KEY in environment/.env')
    from openai import OpenAI

    print(f'LIVE: processing {len(records)} distinct source comments.')
    result = run_ai_pipeline(records, client=OpenAI(timeout=60, max_retries=2))
    run_id = save_run(records, result, db_path=ROOT / args.db, settings={
        'mode': 'live', 'country_filter': args.country,
        'sample_seed': args.seed, 'model': os.getenv('OPENAI_MODEL', 'gpt-5-mini'),
    })
    output = ROOT / 'data/processed/ai_runs' / run_id
    write_jsonl(output / 'findings.jsonl', result['findings'])
    write_jsonl(output / 'clusters.jsonl', result['clusters'])
    write_jsonl(output / 'requirements_drafts.jsonl', result['proposed_requirements'])
    (output / 'run_report.json').write_text(json.dumps({
        'run_id': run_id, 'mode': 'live', 'selection': stats,
        'validation_errors': result['validation_errors'],
        'counts': {'findings': len(result['findings']), 'clusters': len(result['clusters']),
                   'proposals': len(result['proposed_requirements'])},
    }, indent=2, ensure_ascii=False), encoding='utf-8')
    print('RUN ID:', run_id)
    print('RESULT:', {'findings': len(result['findings']), 'clusters': len(result['clusters']),
                      'requirements': len(result['proposed_requirements']),
                      'validation_errors': len(result['validation_errors'])})
    print('SOURCE OUTPUT:', output.relative_to(ROOT))
    print('NEXT: python scripts/review_f70.py list')
    return 0


if __name__ == '__main__':
    sys.exit(main())
