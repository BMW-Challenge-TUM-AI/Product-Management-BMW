"""Render a compact, source-linked project snapshot as a PDF, with no AI calls."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

import reportlab
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

INK = colors.HexColor('#182F41')
BLUE = colors.HexColor('#215774')
MUTED = colors.HexColor('#60717E')
LINE = colors.HexColor('#DCE4E9')
PALE = colors.HexColor('#F2F6F8')
PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN = 43
WIDTH = PAGE_WIDTH - MARGIN * 2
DIMENSIONS = [('impact', 'Impact'), ('frequency', 'Frequency'), ('strategy', 'Strategy'), ('evidence', 'Evidence'), ('feasibility', 'Feasibility')]


def text(value, fallback='Not recorded'):
    if value is None or value == '':
        return fallback
    return str(value)


def safe(value, fallback='Not recorded', preserve=False):
    value = text(value, fallback)
    if not preserve:
        value = value.replace('\u2011', '-').replace('\u2013', '-').replace('\u2014', '-')
    return escape(value).replace('\n', '<br/>')


def number(value):
    return f'{value:,}' if isinstance(value, int) else text(value)


def anchor_id(value):
    return 'finding-' + hashlib.sha256(text(value).encode('utf-8')).hexdigest()[:20]


def stamp(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(timezone.utc).strftime('%d %b %Y, %H:%M UTC')
    except (ValueError, TypeError):
        return text(value)


def build_pdf(data: dict) -> tuple[bytes, str]:
    if data.get('schemaVersion') != 1 or not isinstance(data.get('project'), dict) or not isinstance(data.get('summary'), dict):
        raise ValueError('A current project report snapshot is required.')
    for key, limit in [('datasets', 40), ('findings', 20), ('requirements', 20), ('runs', 10), ('decisions', 15), ('evidenceRequests', 15), ('sourceTopics', 20)]:
        values = data.get(key, [])
        if not isinstance(values, list) or len(values) > limit or any(not isinstance(item, dict) for item in values):
            raise ValueError(f'The report contains an invalid {key} list.')
    font_directory = Path(reportlab.__file__).parent / 'fonts'
    for name, filename in [('Report', 'Vera.ttf'), ('Report-Bold', 'VeraBd.ttf'), ('Report-Italic', 'VeraIt.ttf')]:
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(font_directory / filename)))
    pdfmetrics.registerFontFamily('Report', normal='Report', bold='Report-Bold', italic='Report-Italic', boldItalic='Report-Bold')
    unicode_font = None
    for candidate in [Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf'), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]:
        if candidate.is_file():
            if 'Report-Unicode' not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont('Report-Unicode', str(candidate)))
            unicode_font = pdfmetrics.getFont('Report-Unicode')
            break
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name='ReportTitle', fontName='Report-Bold', fontSize=24, leading=29, textColor=INK, spaceAfter=10))
    styles.add(ParagraphStyle(name='ReportSubtitle', fontName='Report', fontSize=11, leading=16, textColor=MUTED, spaceAfter=13))
    styles.add(ParagraphStyle(name='ReportSection', fontName='Report-Bold', fontSize=14, leading=19, textColor=INK, spaceBefore=19, spaceAfter=8, keepWithNext=True))
    styles.add(ParagraphStyle(name='ReportItem', fontName='Report-Bold', fontSize=10.2, leading=14.5, textColor=INK, spaceBefore=12, spaceAfter=5, keepWithNext=True))
    styles.add(ParagraphStyle(name='ReportBody', fontName='Report', fontSize=8.5, leading=12.8, textColor=INK, spaceAfter=6, splitLongWords=True))
    styles.add(ParagraphStyle(name='ReportSmall', parent=styles['ReportBody'], fontSize=7.2, leading=10.6, textColor=MUTED, spaceAfter=5))
    styles.add(ParagraphStyle(name='ReportQuote', parent=styles['ReportBody'], fontSize=8.1, leading=12.2, leftIndent=10, borderColor=LINE, borderWidth=0.5, borderPadding=7, spaceBefore=3, spaceAfter=8))
    styles.add(ParagraphStyle(name='ReportCell', parent=styles['ReportBody'], fontSize=7.5, leading=10.5, spaceAfter=0))
    styles.add(ParagraphStyle(name='ReportHead', parent=styles['ReportCell'], fontName='Report-Bold', textColor=BLUE))
    flow = []
    def paragraph(value, style='ReportBody'):
        if style != 'ReportQuote':
            return Paragraph(safe(value), styles[style])
        # Quotations keep exact source characters, including typographic punctuation.
        quote = text(value)
        normal_font = pdfmetrics.getFont('Report')
        runs = []
        for character in quote:
            escaped = escape(character)
            if ord(character) not in normal_font.face.charToGlyph and unicode_font and ord(character) in unicode_font.face.charToGlyph:
                runs.append(f'<font name="Report-Unicode">{escaped}</font>')
            else:
                runs.append(escaped)
        return Paragraph(''.join(runs).replace('\n', '<br/>'), styles[style])

    def body(value, style='ReportBody'):
        flow.append(paragraph(value, style))

    def label(name, value, style='ReportBody'):
        flow.append(Paragraph(f'<b>{safe(name)}:</b> {safe(value)}', styles[style]))

    def section(title, note=None):
        body(title, 'ReportSection')
        if note:
            body(note, 'ReportSmall')

    def table(headers, rows, widths):
        table_rows = [[paragraph(cell, 'ReportHead') for cell in headers]]
        table_rows += [[paragraph(cell, 'ReportCell') for cell in row] for row in rows]
        item = Table(table_rows, colWidths=[WIDTH * size for size in widths], repeatRows=1, hAlign='LEFT')
        item.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), PALE), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
            ('LINEBELOW', (0, 0), (-1, -1), 0.4, LINE),
        ]))
        flow.append(item)
        flow.append(Spacer(1, 5))

    project, summary = data['project'], data['summary']
    selection = data.get('selection', {})
    body('INSIGHTPILOT / PROJECT REPORT', 'ReportSmall')
    body(project.get('name'), 'ReportTitle')
    body(' | '.join(text(project.get(key)) for key in ['derivative', 'market', 'horizon']), 'ReportSubtitle')
    body(f"Exported {stamp(data.get('generatedAt'))} | Workspace revision {text(data.get('workspaceRevision'))}", 'ReportSmall')
    body('A snapshot of supplied sources, saved analysis and recorded product decisions. Source counts describe this workspace; they do not estimate market prevalence.')
    excluded = data.get('excludedSynthetic', {})
    if any(excluded.values()):
        excluded_labels = {'datasets': 'datasets', 'records': 'source records', 'findings': 'findings', 'requirements': 'requirements', 'demoRuns': 'demo analysis runs'}
        body('Excluded synthetic data: ' + '; '.join(f'{number(value)} {excluded_labels.get(key, key)}' for key, value in excluded.items() if value) + '. These records do not contribute to report totals or quoted evidence.', 'ReportSmall')
    table(['Source coverage', 'Product findings', 'Human review'], [[
        f"{number(summary.get('feedbackRecords'))} customer comments\n{number(summary.get('referenceRecords'))} reference records\n{number(summary.get('datasets'))} datasets",
        f"{number(summary.get('findings'))} findings\n{number(summary.get('requirements'))} requirements\n{number(summary.get('analysisRuns'))} saved analysis runs",
        f"{number(summary.get('approvedRequirements'))} approved requirements\n{number(summary.get('unscoredRequirements'))} with incomplete scores\n{number(summary.get('openEvidenceRequests'))} open evidence requests",
    ]], [0.34, 0.33, 0.33])
    label('Analysis coverage', f"{number(summary.get('analyzedSourceRecords'))} distinct current source records covered by saved AI run ranges; {number(summary.get('linkedSourceRecords'))} records linked to active findings.")
    label('Original feedback annotations', f"{number(summary.get('annotationRows'))} original annotation rows across {number(summary.get('topics'))} source topics. Distinct comment counts use the same deduplication as Overview.", 'ReportSmall')
    if summary.get('runsWithoutCoverage'):
        body(f"{number(summary['runsWithoutCoverage'])} AI runs have unavailable or unmatched coverage metadata and are excluded from the distinct analyzed-record count.", 'ReportSmall')
    label('Requirement status', '; '.join(f'{key}: {number(value)}' for key, value in summary.get('statuses', {}).items()) or 'No requirements yet')
    label('Priority', '; '.join(f'{key}: {number(value)}' for key, value in summary.get('priorities', {}).items()) or 'No requirements yet')
    body('Unknown scoring dimensions remain unknown. AI suggestions require human review; confidence labels and frequency scores are qualitative heuristics.', 'ReportSmall')

    section('1. Supplied sources', f"Showing {len(data.get('datasets', []))} of {number(selection.get('datasets', len(data.get('datasets', []))))} internal datasets. Inventory row counts describe each imported dataset and may repeat comments from duplicate imports; the project comment total above is deduplicated. Study, sales and equipment records are reference context.")
    if data.get('datasets'):
        table(['Dataset / original files', 'Role and status', 'Records'], [[
            f"{text(item.get('name'))}\n" + '\n'.join(item.get('files', [])) + (f"\n{number(item['omittedFiles'])} more files omitted" if item.get('omittedFiles') else ''),
            f"{text(item.get('type'))}\n{text(item.get('status'))}" + ('\n' + '\n'.join(item['errors']) if item.get('errors') else '') + (f"\n{number(item['omittedErrors'])} more validation messages omitted" if item.get('omittedErrors') else ''),
            number(item.get('records')),
        ] for item in data['datasets']], [0.56, 0.30, 0.14])
    else:
        body('No internal source datasets are saved for this project.')
    if data.get('sourceTopics'):
        body('Source topic counts', 'ReportItem')
        body(f"Showing {len(data['sourceTopics'])} of {number(selection.get('topics'))} source topics, ordered by distinct comment count. Comments can belong to several topics or source labels. Negative, positive and request labels come from the supplied workbook, not inferred sentiment.", 'ReportSmall')
        table(['Source topic', 'Comments', 'Annotations', 'Source label counts'], [[
            item.get('name'), number(item.get('comments')), number(item.get('annotations')),
            f"Negative {number(item.get('negative'))}\nPositive {number(item.get('positive'))}\nRequests {number(item.get('requests'))}\nUnknown {number(item.get('unknown'))}",
        ] for item in data['sourceTopics']], [0.43, 0.14, 0.15, 0.28])

    section('2. Analysis coverage and recorded metrics', f"Showing {len(data.get('runs', []))} of {number(selection.get('runs', len(data.get('runs', []))))} saved runs, newest first. Repeated batches can overlap; their sizes must not be summed as unique coverage.")
    for run in data.get('runs', []):
        body(f"{text(run.get('mode'))} run | {stamp(run.get('at'))}", 'ReportItem')
        body(run.get('id'), 'ReportSmall')
        coverage = run.get('coverage')
        if isinstance(coverage, dict):
            label('Batch', f"{number(coverage.get('batch'))} of {number(coverage.get('batches'))}; records {number(coverage.get('first'))}-{number(coverage.get('last'))} of {number(coverage.get('total'))} selected records")
        else:
            label('Batch coverage', 'Not recorded')
        label('Saved output', f"{number(run.get('findings'))} new findings; {number(run.get('requirements'))} new requirements")
        metrics = run.get('metrics')
        if isinstance(metrics, dict):
            seconds = metrics.get('seconds')
            duration = f'{seconds:.1f}s' if isinstance(seconds, (int, float)) and math.isfinite(seconds) else 'Not recorded'
            label('Runtime', f"{text(metrics.get('model'))}; {duration}; {number(metrics.get('api_calls'))} API calls")
            label('Recorded tokens', f"Input {number(metrics.get('input_tokens'))}; output {number(metrics.get('output_tokens'))}; reasoning {number(metrics.get('reasoning_tokens'))}", 'ReportSmall')
        else:
            body('Runtime and token metrics were not saved for this run.', 'ReportSmall')
    if not data.get('runs'):
        body('No completed analysis runs are saved in this project snapshot.')

    section('3. Source-linked findings', f"Showing {len(data.get('findings', []))} of {number(selection.get('findings', len(data.get('findings', []))))} findings. Findings linked to the selected requirements are listed first, then active findings with the most linked sources. Up to two source quotations or excerpts are included per finding.")
    finding_ids = {item.get('id') for item in data.get('findings', [])}
    for finding in data.get('findings', []):
        flow.append(Paragraph(f'<a name="{anchor_id(finding.get("id"))}"/>{safe(finding.get("title"))}', styles['ReportItem']))
        body(f"{text(finding.get('id'))} | {text(finding.get('category'))} | {text(finding.get('status'))} | {text(finding.get('strength'))} evidence", 'ReportSmall')
        if finding.get('synthetic'):
            body('SYNTHETIC FINDING', 'ReportSmall')
        body(finding.get('summary'))
        label('Customer need', finding.get('need'))
        label('Limitations / next assessment', finding.get('implication'), 'ReportSmall')
        label('Linked source IDs', ', '.join(finding.get('sourceIds', [])) + (f"; {number(finding['omittedSourceIds'])} additional IDs omitted" if finding.get('omittedSourceIds') else ''), 'ReportSmall')
        if finding.get('contradictionCount'):
            label('Counterevidence', f"{number(finding['contradictionCount'])} linked contradicting sources: " + ', '.join(finding.get('contradictionSourceIds', [])) + (f"; {number(finding['omittedContradictionIds'])} additional IDs omitted" if finding.get('omittedContradictionIds') else ''), 'ReportSmall')
            if not finding.get('counterQuotes'):
                body('No original counterevidence record is available among the included non-synthetic project sources.', 'ReportSmall')
        for quote in finding.get('quotes', []) + finding.get('counterQuotes', []):
            quote_text = text(quote.get('text'), '')
            quote_paragraph = paragraph(f'“{quote_text}”' + (' [excerpt shortened]' if quote.get('truncated') else ''), 'ReportQuote')
            location = [text(quote.get('file'))]
            if quote.get('sheet'):
                location.append(text(quote['sheet']))
            if quote.get('row') is not None:
                location.append(f"row {quote['row']}")
            if quote.get('page') is not None:
                location.append(f"page {quote['page']}")
            if quote.get('market'):
                location.append(text(quote['market']))
            provenance = paragraph(f"{text(quote.get('kind'))} | {text(quote.get('sourceId'))}\n" + ' | '.join(location), 'ReportSmall')
            flow.append(KeepTogether([quote_paragraph, provenance]))
        if finding.get('missingSources'):
            body(f"{number(finding.get('missingSourceCount', len(finding['missingSources'])))} unavailable source records. Selected IDs: " + ', '.join(finding['missingSources']), 'ReportSmall')
        if not finding.get('quotes'):
            body('No linked original source text is available in the current project snapshot.', 'ReportSmall')
    if not data.get('findings'):
        body('No findings have been saved for this project.')

    section('4. Requirements and scoring', f"Showing {len(data.get('requirements', []))} of {number(selection.get('requirements', len(data.get('requirements', []))))} requirements, ordered by recorded priority, score, then latest update. Any priority override is shown explicitly.")
    for item in data.get('requirements', []):
        body(item.get('title'), 'ReportItem')
        score = item.get('score')
        score_text = f'{score:g}/100' if isinstance(score, (int, float)) else 'Unknown - incomplete scores'
        body(f"{text(item.get('id'))} | v{number(item.get('version'))} | {text(item.get('status'))} | {text(item.get('category'))}", 'ReportSmall')
        if item.get('synthetic'):
            body('SYNTHETIC REQUIREMENT', 'ReportSmall')
        body(item.get('statement'))
        label('Priority and evidence', f"{text(item.get('priority'))}; weighted score {score_text}; {text(item.get('evidence'))} evidence")
        scores = item.get('scores', {})
        body(' | '.join(f"{name}: {text(scores.get(key), 'Unknown')}{'/5' if scores.get(key) is not None else ''}" for key, name in DIMENSIONS), 'ReportSmall')
        if item.get('priorityOverride'):
            label('PM priority override', f"{item['priorityOverride']} - {text(item.get('overrideReason'))}")
        labels = []
        for finding_id in item.get('findings', []):
            labels.append(f'<link href="#{anchor_id(finding_id)}" color="#215774">{safe(finding_id)}</link>' if finding_id in finding_ids else safe(finding_id) + ' (outside this excerpt)')
        flow.append(Paragraph('<b>Linked findings:</b> ' + (', '.join(labels) or 'None recorded'), styles['ReportSmall']))
        if item.get('omittedFindingIds'):
            body(f"{number(item['omittedFindingIds'])} additional linked finding IDs omitted.", 'ReportSmall')
        label('Rationale', item.get('rationale'))
        if item.get('assumptions'):
            label('Assumptions', item['assumptions'], 'ReportSmall')
        if item.get('uncertainty'):
            label('Uncertainty and validation', item['uncertainty'], 'ReportSmall')
    if not data.get('requirements'):
        body('No requirements have been saved for this project.')
    scoring = data.get('scoring', {})
    body(f"Scoring model v{number(scoring.get('version'))}", 'ReportItem')
    weights = scoring.get('weights', {})
    body(' | '.join(f"{name}: {text(weights.get(key))}%" for key, name in DIMENSIONS))
    thresholds = scoring.get('thresholds', {})
    body(f"Weighted score = sum(weight x dimension score / 5). P1 at {text(thresholds.get('p1'))} or above; P2 at {text(thresholds.get('p2'))} or above; otherwise P3. A weighted score requires all five valid dimension scores.", 'ReportSmall')

    section('5. Recent recorded human decisions', f"Showing {len(data.get('decisions', []))} of {number(selection.get('decisions', len(data.get('decisions', []))))} PM audit events, newest first.")
    for decision in data.get('decisions', []):
        body(decision.get('action'), 'ReportItem')
        body(f"{stamp(decision.get('at'))} | {text(decision.get('actor'))} | {text(decision.get('entityId'))}", 'ReportSmall')
        label('Documented rationale', decision.get('rationale'))
    if not data.get('decisions'):
        body('No human decisions have been recorded for this project.')
    if data.get('evidenceRequests'):
        section('6. Open evidence requests', f"Showing {len(data['evidenceRequests'])} of {number(selection.get('requests', len(data['evidenceRequests'])))} open requests.")
        for request in data['evidenceRequests']:
            label(text(request.get('requirementId')), request.get('text'))
    flow.append(Spacer(1, 12))
    body('Report scope: the current project and non-synthetic internal datasets, findings and requirements. Source references retain original file, sheet, row or page identifiers where available. Inventory is limited to 40 datasets, five filenames and three validation messages per dataset; identifier lists to 12 entries; prose to 1,400 characters per field. Shortened fields and omitted rows are labelled. The complete saved records remain in the workspace.', 'ReportSmall')
    if selection.get('payloadTrimmed'):
        body('Additional detail rows were omitted to keep this report snapshot below 800 KB. Project totals remain complete.', 'ReportSmall')

    def furniture(canvas, document):
        canvas.saveState()
        canvas.setStrokeColor(LINE)
        canvas.line(MARGIN, 38, PAGE_WIDTH-MARGIN, 38)
        canvas.setFont('Report', 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN, 26, 'InsightPilot | ' + text(project.get('derivative'))[:52])
        canvas.drawRightString(PAGE_WIDTH-MARGIN, 26, f'Page {document.page}')
        canvas.restoreState()

    output = io.BytesIO()
    document = SimpleDocTemplate(output, pagesize=A4, rightMargin=MARGIN, leftMargin=MARGIN, topMargin=36, bottomMargin=52,
                                 title=f"InsightPilot - {text(project.get('derivative'))} - {text(project.get('market'))}", author='InsightPilot')
    document.build(flow, onFirstPage=furniture, onLaterPages=furniture)
    slug = re.sub(r'[^A-Za-z0-9._-]+', '-', f"{text(project.get('derivative'))}-{text(project.get('market'))}").strip('-')[:100] or 'project'
    return output.getvalue(), f'insightpilot-{slug}.pdf'


def main():
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        raise ValueError('A project report object is required.')
    content, filename = build_pdf(request)
    json.dump({'filename': filename, 'pdf_base64': base64.b64encode(content).decode('ascii')}, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, TypeError, KeyError) as exc:
        json.dump({'error': str(exc)}, sys.stdout)
        sys.exit(1)
    except Exception:
        json.dump({'error': 'Could not create the project PDF. Check the local report service and dependencies.'}, sys.stdout)
        sys.exit(1)
