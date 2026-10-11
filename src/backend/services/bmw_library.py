"""Local-only adapters for the supplied BMW files.

The files stay in ignored data/raw/. This module returns one vehicle/market
scope at a time and never writes a derived customer-data file.
"""
from __future__ import annotations

import csv
import hashlib
import math
import re
from collections import OrderedDict
from pathlib import Path

from src.backend.services.source_files import discover_source_files, read_source_file

ROOT = Path(__file__).resolve().parents[3]
RAW = ROOT / 'data' / 'raw'
FEEDBACK_FILES = {
    'F70': 'F70_feedback_hackathon.xlsx',
    'G60': 'G60_feedback_hackathon.xlsx',
    'G70': 'G70_feedback_hackathon.xlsx',
}
CATALOG_FILES = {
    'F70': 'F70_OptionList.PDF',
    'G60': 'G60_OptionList.PDF',
    'G70': 'G70_OptionList.PDF',
}
STUDY_FILE = 'F70_G60_G68_G70_customer_studies.xlsx'
SALES_FILE = 'sales_volumes.xlsx'
EQUIPMENT_FILE = 'f70_equipment_curated.csv'
MODEL_SERIES = {'F70': '1', 'G60': '5', 'G68': '5', 'G70': '7'}
VEHICLES = {
    'F70': 'BMW 1 Series F70',
    'G60': 'BMW 5 Series G60',
    'G68': 'BMW 5 Series G68',
    'G70': 'BMW 7 Series G70',
}
MARKETS = {
    'GB': 'United Kingdom', 'JP': 'Japan', 'SE': 'Sweden',
    'FR': 'France', 'AU': 'Australia', 'DK': 'Denmark',
    'FI': 'Finland', 'KR': 'South Korea', 'ZA': 'South Africa',
    'DE': 'Germany', 'EU': 'Europe', 'CN': 'China',
    'US': 'United States', 'CA': 'Canada', 'NO': 'Norway',
    'ES': 'Spain', 'LV': 'Latvia', 'ROW': 'Rest of World',
}
DATASET_NAMES = {
    'feedback': 'Customer verbatims', 'studies': 'Customer study',
    'sales': 'Sales volumes', 'equipment': 'Equipment list',
}
# Analysis markets from the challenge. Country labels below remain source provenance;
# EU totals and country-level feedback must never be presented as the same granularity.
ANALYSIS_MARKETS = {'EU': 'Europe', 'US': 'United States', 'CN': 'China'}
EUROPE_SOURCE_CODES = {'EU', 'GB', 'SE', 'FR', 'DK', 'FI', 'DE', 'NO', 'ES', 'LV'}
SERIES_MODELS = {
    '1': {'EU': 'F70', 'US': 'F70', 'CN': 'F70'},
    '5': {'EU': 'G60', 'US': 'G60', 'CN': 'G68'},
    '7': {'EU': 'G70', 'US': 'G70', 'CN': 'G70'},
}
SUPPORTED_SCOPES = {(model, market): series
                    for series, markets in SERIES_MODELS.items()
                    for market, model in markets.items()}


def _belongs_to_market(source_code: str, analysis_code: str) -> bool:
    return source_code in EUROPE_SOURCE_CODES if analysis_code == 'EU' else source_code == analysis_code


def _regional_records(mapping: dict[tuple[str, str], list[dict]], model: str, market: str) -> list[dict]:
    records = []
    for (source_model, source_market), rows in mapping.items():
        if source_model != model or not _belongs_to_market(source_market, market):
            continue
        for row in rows:
            records.append({**row, 'fields': {
                **row['fields'], 'analysis_market_code': market,
                'analysis_market_label': ANALYSIS_MARKETS.get(market, MARKETS[market]),
                'source_market_granularity': 'regional' if source_market == 'EU' else 'country',
            }})
    return records


def _id(prefix: str, *parts: object) -> str:
    digest = hashlib.sha256('\n'.join(map(str, parts)).encode()).hexdigest()[:16]
    return f'BMW-{prefix}-{digest}'


def _code(value: object) -> str:
    match = re.search(r'\b(F70|G60|G68|G70)\b', str(value or '').upper())
    return match.group(1) if match else ''


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


def _record(kind: str, model: str, market: str, source: str, sheet: str,
            row: int, content: str, fields: dict, *, identity: object,
            category: str = '') -> dict:
    return {
        'id': _id(kind.upper(), model, market, source, sheet, identity),
        'content': content, 'row': row, 'sheet': sheet, 'category': category,
        'fields': {
            'source_file': source, 'source_sheet': sheet, 'source_row': row,
            'source_vehicle_code': model, 'source_market_code': market,
            'source_market_label': MARKETS[market], 'source_type': kind,
            **fields,
        },
    }


def _feedback() -> dict[tuple[str, str], list[dict]]:
    result: dict[tuple[str, str], list[dict]] = {}
    for expected_model, filename in FEEDBACK_FILES.items():
        path = RAW / filename
        if not path.exists():
            continue
        document = read_source_file(path)
        sheet = next((item for item in document['sheets'] if item['name'] == 'Feedback_Explorer'),
                     document['sheets'][0] if document['sheets'] else None)
        if not sheet or not sheet['columns']:
            raise ValueError(f'{filename} has no header row.')
        grouped: OrderedDict[tuple[str, str], dict] = OrderedDict()
        for source_row in sheet['records']:
            row_number, item = source_row['row'], source_row['fields']
            original_id = str(item.get('ID') or '').strip()
            text = str(item.get('Customer Feedback') or '').strip()
            market = str(item.get('Country') or '').strip().upper()
            model = _code(item.get('Derivate (e-code)'))
            if not original_id or not text or model != expected_model or market not in MARKETS:
                raise ValueError(f'{filename} row {row_number} has missing or unsupported identity, text, vehicle, or market.')
            annotation = {
                'row': row_number, 'feedback_type': item.get('Feedback Type'),
                'category_level_2': item.get('Vfc level2 Name'),
                'category_level_2_3': item.get('Vfc level2 3 Name'),
                'category_level_3': item.get('Vfc level3 Name'),
            }
            key = (market, original_id)
            if key not in grouped:
                grouped[key] = {
                    'text': text, 'market': market, 'model': model,
                    'first_row': row_number, 'source': item.get('Source'),
                    'brand': item.get('Brand'), 'sales_description': item.get('Sales Description'),
                    'engine_type': item.get('Engine Type'), 'annotations': [],
                }
            group = grouped[key]
            if (group['text'], group['model']) != (text, model):
                raise ValueError(f'Feedback ID {original_id} has conflicting text or vehicle across rows.')
            group['annotations'].append(annotation)
        for (market, original_id), group in grouped.items():
            model = group['model']
            record = _record('feedback', model, market, path.name, sheet['name'],
                             group['first_row'], group['text'], {
                                 '_originalId': original_id, 'original_row_count': len(group['annotations']),
                                 'annotations': group['annotations'], 'source': group['source'],
                                 'brand': group['brand'], 'sales_description': group['sales_description'],
                                 'engine_type': group['engine_type'],
                             }, identity=original_id,
                             category=str(group['annotations'][0].get('category_level_2') or ''))
            result.setdefault((model, market), []).append(record)
    return result


def _studies() -> dict[tuple[str, str], list[dict]]:
    path = RAW / STUDY_FILE
    if not path.exists():
        return {}
    document = read_source_file(path)
    sheets = {sheet['name']: sheet for sheet in document['sheets']}
    result: dict[tuple[str, str], list[dict]] = {}
    if 'CN_EU_2025' in sheets:
        sheet = sheets['CN_EU_2025']
        rows = [row['values'] for row in sheet['rows']]
        models = rows[2]
        market = ''
        scopes: dict[int, tuple[str, str]] = {}
        for column in range(1, len(models)):
            if rows[1][column]:
                market = {'EU': 'EU', 'China': 'CN'}.get(str(rows[1][column]), '')
            model = _code(models[column])
            if model and market:
                scopes[column] = model, market
        category = str(models[0] or '')
        for row_number, row in enumerate(rows[3:], start=4):
            if str(row[0] or '').strip().lower() != 'mean':
                if row[0]:
                    category = str(row[0]).strip()
                continue
            for column, (model, market) in scopes.items():
                value = _number(row[column] if column < len(row) else None)
                if value is None:
                    continue
                fields = {
                    'category': category, 'measure': 'mean rating', 'value': value,
                    'scale': 'Not stated in workbook', 'source_column': column + 1,
                    'source_model_label': str(models[column]), 'study_year': 2025,
                }
                result.setdefault((model, market), []).append(_record(
                    'study', model, market, path.name, sheet['name'], row_number,
                    f'{category}: mean rating {value:g} (source scale not stated)',
                    fields, identity=f'R{row_number}C{column+1}', category=category))
    if 'US_2025' in sheets:
        sheet = sheets['US_2025']
        rows = [row['values'] for row in sheet['rows']]
        models = rows[0]
        scopes = {column: _code(models[column]) for column in range(2, len(models)) if _code(models[column])}
        category = str(models[0] or '')
        for row_number, row in enumerate(rows[1:], start=2):
            has_value = any(_number(row[col] if col < len(row) else None) is not None for col in scopes)
            if not has_value:
                if row[0]:
                    category = str(row[0]).strip()
                continue
            response = str(row[0] or '').strip()
            measure = str(row[1] or '').strip()
            for column, model in scopes.items():
                value = _number(row[column] if column < len(row) else None)
                if value is None:
                    continue
                fields = {
                    'category': category, 'response': response, 'measure': measure,
                    'value': value, 'unit': 'fraction of column; not a mean rating',
                    'source_column': column + 1, 'source_model_label': str(models[column]),
                    'study_year': 2025,
                }
                result.setdefault((model, 'US'), []).append(_record(
                    'study', model, 'US', path.name, sheet['name'], row_number,
                    f'{category} — {response}: {value:g} of column ({measure})',
                    fields, identity=f'R{row_number}C{column+1}', category=category))
    return result


def _sales() -> dict[tuple[str, str], list[dict]]:
    path = RAW / SALES_FILE
    if not path.exists():
        return {}
    document = read_source_file(path)
    result: dict[tuple[str, str], list[dict]] = {}
    for sheet in document['sheets']:
        source_scope = sheet['name']
        targets = ['G60', 'G68'] if source_scope == 'G60_G68' else [source_scope]
        if any(model not in VEHICLES for model in targets):
            continue
        for source_row in sheet['records']:
            row_number, item = source_row['row'], source_row['fields']
            market = str(item.get('market_code') or '').strip().upper()
            if market not in MARKETS:
                raise ValueError(f'Sales row {row_number} in {source_scope} has an unsupported market.')
            for year in (2024, 2025, 2030):
                value = _number(item.get(f'volume_{year}'))
                if value is None:
                    continue
                for model in targets:
                    shared = source_scope == 'G60_G68'
                    note = ('Combined G60/G68 series total; it cannot be attributed to either model alone. '
                            if shared else '')
                    if year == 2030:
                        note += '2030 is future-looking in the supplied file; its forecast basis is not stated.'
                    fields = {
                        'market_original': item.get('market'), 'market_code_original': market,
                        'year': year, 'volume': value, 'source_model_scope': source_scope,
                        'combined_model_scope': shared, 'future_value': year == 2030,
                        'interpretation_note': note,
                    }
                    record = _record('sales', model, market, path.name, sheet['name'],
                                     row_number, f'{MARKETS[market]} · {source_scope} · {year}: {value:g} units. {note}'.strip(),
                                     fields, identity=f'{market}-{year}')
                    result.setdefault((model, market), []).append(record)
    return result


def _equipment() -> dict[tuple[str, str], list[dict]]:
    curated = RAW / EQUIPMENT_FILE
    available_catalogs = [(model, RAW / filename) for model, filename in CATALOG_FILES.items()
                          if (RAW / filename).exists()]
    if not available_catalogs and not curated.exists():
        return {}
    result: dict[tuple[str, str], list[dict]] = {}
    page_text: dict[str, dict[int, str]] = {}
    for model, pdf in available_catalogs:
        document = read_source_file(pdf)
        pages = {page['page']: page['text'] for page in document['pages']}
        page_text[model] = pages
        # The option-list PDFs are the supplied German-market catalogs.
        scope_records = result.setdefault((model, 'DE'), [])
        for page, text in pages.items():
            scope_records.append(_record('catalog', model, 'DE', pdf.name, 'PDF page', page,
                                         text, {'catalog_page': page, 'availability': 'See original table; not auto-classified'},
                                         identity=page, category='Catalog page'))
    if curated.exists():
        pages = page_text.get('F70')
        if pages is None:
            raise ValueError('The curated F70 equipment labels require F70_OptionList.PDF.')
        with curated.open(encoding='utf-8-sig', newline='') as stream:
            for index, item in enumerate(csv.DictReader(stream), start=2):
                page = int(item['page'])
                quote = item['source_text_match'].strip()
                if page not in pages or not quote or quote not in pages[page]:
                    raise ValueError(f'Equipment CSV row {index} does not match catalog PDF page {page}.')
                name = item['feature_name_en'].strip() or item['feature_name_original'].strip()
                fields = {**item, 'source_pdf': CATALOG_FILES['F70'], 'source_pdf_page': page,
                          'original_csv_row': index,
                          'review_note': 'Curated classification is an initial manual review; check catalog symbols and variant restrictions.'}
                result[('F70', 'DE')].append(_record('equipment', 'F70', 'DE', curated.name, 'Curated CSV', index,
                                                      f'{name}: {item["availability"]}. PDF page {page}: {quote}',
                                                      fields, identity=index, category=item['category']))
    return result


def _all() -> dict[str, dict[tuple[str, str], list[dict]]]:
    return {'feedback': _feedback(), 'studies': _studies(), 'sales': _sales(), 'equipment': _equipment()}


def _source_files() -> list[dict]:
    files = [{'kind': 'feedback', 'model_code': model, 'name': name,
              'available': (RAW / name).exists()} for model, name in FEEDBACK_FILES.items()]
    files.extend([
        {'kind': 'studies', 'name': STUDY_FILE, 'available': (RAW / STUDY_FILE).exists()},
        {'kind': 'sales', 'name': SALES_FILE, 'available': (RAW / SALES_FILE).exists()},
        {'kind': 'equipment', 'name': EQUIPMENT_FILE, 'available': (RAW / EQUIPMENT_FILE).exists()},
    ])
    files.extend({'kind': 'catalog', 'model_code': model, 'name': name,
                  'available': (RAW / name).exists()} for model, name in CATALOG_FILES.items())
    known = {item['name'] for item in files}
    files.extend({**item, 'kind': 'document'} for item in discover_source_files(RAW)
                 if item['name'] not in known)
    for item in files:
        suffix = Path(item['name']).suffix.lower()
        if suffix in {'.xlsx', '.pdf'}:
            item['format'] = suffix[1:]
    return files


def _scope_series(model: str, market: str) -> str | None:
    core = SUPPORTED_SCOPES.get((model, market))
    if core:
        return core
    return MODEL_SERIES.get(model) if market in MARKETS and market not in ANALYSIS_MARKETS else None


def _available_scopes(data: dict[str, dict[tuple[str, str], list[dict]]]) -> dict[tuple[str, str], str]:
    scopes = dict(SUPPORTED_SCOPES)
    for mapping in data.values():
        for model, source_market in mapping:
            if source_market not in ANALYSIS_MARKETS:
                scopes.setdefault((model, source_market), MODEL_SERIES[model])
    return scopes


def manifest() -> dict:
    data = _all()
    scopes = []
    candidates = _available_scopes(data)
    core_order = list(SUPPORTED_SCOPES)
    extra_order = sorted(set(candidates) - set(SUPPORTED_SCOPES), key=lambda key: (MODEL_SERIES[key[0]], MARKETS[key[1]], key[0]))
    for model, market in core_order + extra_order:
        series = candidates[(model, market)]
        scoped = {kind: _regional_records(mapping, model, market) for kind, mapping in data.items()}
        counts = {kind: len(records) for kind, records in scoped.items()}
        if any(counts.values()):
            scopes.append({'series': series, 'model_code': model, 'vehicle': VEHICLES[model],
                           'market_code': market, 'market': ANALYSIS_MARKETS.get(market, MARKETS[market]),
                           'counts': counts,
                           'feedback_annotation_rows': sum(int(record['fields'].get('original_row_count', 1))
                                                           for record in scoped['feedback'])})
    return {
        'files': _source_files(),
        'scopes': scopes,
        'notes': [
            'Europe combines supplied European country feedback with Europe-wide studies and sales; each record retains its original market and granularity. No German customer feedback is supplied.',
            'Feedback counts are distinct source IDs. Repeated worksheet rows are retained as annotations on one feedback comment and reported separately.',
            'Country scopes outside Europe, United States, and China remain available as their own source projects.',
            'G60/G68 sales are one combined series total. Do not attribute the total to either model alone.',
            'The 5 Series uses G60 for Europe and United States, and G68 for China. Combined G60/G68 sales remain a series total.',
            'F70 United States and China scopes have sales rows only; market availability and relevance require separate verification.',
            'The option catalogs are German-market sources. Curated F70 feature labels need PM verification.',
            'Study mean ratings and US response fractions are different measures. 2030 sales are future-looking.',
        ],
    }


def load_scope(model_code: str, market_code: str) -> dict:
    series = _scope_series(model_code, market_code)
    if not series:
        raise ValueError('Choose a vehicle and market shown in the BMW data library.')
    data = _all()
    datasets = []
    for kind, mapping in data.items():
        records = _regional_records(mapping, model_code, market_code)
        if not records:
            continue
        sources = sorted({str(record['fields']['source_file']) for record in records})
        datasets.append({
            'kind': kind, 'type': DATASET_NAMES[kind],
            'name': f'BMW {model_code} {ANALYSIS_MARKETS.get(market_code, MARKETS[market_code])} · {DATASET_NAMES[kind]}',
            'sources': sources, 'records': records,
        })
    if not datasets:
        raise ValueError('No supplied BMW records match that vehicle and market.')
    counts = {dataset['kind']: len(dataset['records']) for dataset in datasets}
    feedback_rows = sum(int(record['fields'].get('original_row_count', 1))
                        for dataset in datasets if dataset['kind'] == 'feedback'
                        for record in dataset['records'])
    return {'series': series, 'model_code': model_code, 'vehicle': VEHICLES[model_code],
            'market_code': market_code, 'market': ANALYSIS_MARKETS.get(market_code, MARKETS[market_code]),
            'datasets': datasets, 'counts': counts, 'feedback_annotation_rows': feedback_rows,
            'record_count': sum(counts.values())}
