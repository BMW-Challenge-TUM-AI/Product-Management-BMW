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
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

INK = colors.HexColor('#182F41')
BLUE = colors.HexColor('#215774')
MUTED = colors.HexColor('#60717E')
LINE = colors.HexColor('#DCE4E9')
PALE = colors.HexColor('#F2F6F8')
PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN = 43
WIDTH = PAGE_WIDTH - MARGIN * 2
DIMENSIONS = [('impact', 'Impact'), ('frequency', 'Frequency'), ('strategy', 'Strategy'), ('evidence', 'Evidence'), ('feasibility', 'Feasibility')]


def build_compact_pdf(data: dict) -> tuple[bytes, str]:
    """Build a decision brief capped at three deliberate pages."""
    project, summary = data['project'], data['summary']
    font_directory = Path(reportlab.__file__).parent / 'fonts'
    for name, filename in [('Report', 'Vera.ttf'), ('Report-Bold', 'VeraBd.ttf'), ('Report-Italic', 'VeraIt.ttf')]:
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(font_directory / filename)))
    pdfmetrics.registerFontFamily('Report', normal='Report', bold='Report-Bold', italic='Report-Italic', boldItalic='Report-Bold')
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name='BriefTitle', fontName='Report-Bold', fontSize=21, leading=25, textColor=INK, spaceAfter=5))
    styles.add(ParagraphStyle(name='BriefSub', fontName='Report', fontSize=9, leading=12, textColor=MUTED, spaceAfter=8))
    styles.add(ParagraphStyle(name='BriefSection', fontName='Report-Bold', fontSize=12, leading=15, textColor=INK, spaceBefore=8, spaceAfter=5, keepWithNext=True))
    styles.add(ParagraphStyle(name='BriefBody', fontName='Report', fontSize=7.6, leading=9.6, textColor=INK, spaceAfter=4))
    styles.add(ParagraphStyle(name='BriefSmall', parent=styles['BriefBody'], fontSize=6.7, leading=8.2, textColor=MUTED))
    styles.add(ParagraphStyle(name='BriefCell', parent=styles['BriefBody'], fontSize=6.6, leading=8.1, spaceAfter=0))
    styles.add(ParagraphStyle(name='BriefHead', parent=styles['BriefCell'], fontName='Report-Bold', textColor=BLUE))

    flow = []
    def p(value, style='BriefBody'):
        return Paragraph(safe(value, ''), styles[style])
    def add(value, style='BriefBody'):
        flow.append(p(value, style))
    def table(headers, rows, widths):
        values = [[p(item, 'BriefHead') for item in headers]]
        values += [[p(item, 'BriefCell') for item in row] for row in rows]
        item = Table(values, colWidths=[WIDTH * size for size in widths], repeatRows=1, hAlign='LEFT')
        item.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), PALE), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LINEBELOW', (0, 0), (-1, -1), 0.35, LINE),
        ]))
        flow.append(item)
        flow.append(Spacer(1, 5))
    def section(title, note=''):
        add(title, 'BriefSection')
        if note:
            add(note, 'BriefSmall')

    def short(value, limit=180):
        value = text(value, '')
        return value if len(value) <= limit else value[:limit - 3] + '...'

    add('INSIGHTPILOT / DECISION BRIEF', 'BriefSmall')
    add(project.get('name'), 'BriefTitle')
    add(' | '.join(text(project.get(key)) for key in ['derivative', 'market', 'horizon']), 'BriefSub')
    add('Generated ' + stamp(data.get('generatedAt')) + '. This brief covers only the selected project and non-synthetic saved evidence.', 'BriefSmall')
    section('1. Executive summary', 'Use this page to understand what is available before acting on the recommendations.')
    table(['Customer evidence', 'Analysis output', 'PM decision state'], [[
        f"{number(summary.get('feedbackRecords'))} comments\n{number(summary.get('annotationRows'))} annotation rows\n{number(summary.get('topics'))} source topics",
        f"{number(summary.get('findings'))} findings\n{number(summary.get('requirements'))} requirements\n{number(summary.get('analysisRuns'))} analysis runs",
        f"{number(summary.get('approvedRequirements'))} approved\n{number(summary.get('unscoredRequirements'))} incomplete scores\n{number(summary.get('openEvidenceRequests'))} open evidence requests",
    ]], [0.34, 0.33, 0.33])
    add(f"Priority mix: {number(summary.get('priorities', {}).get('P1', 0))} P1, {number(summary.get('priorities', {}).get('P2', 0))} P2, {number(summary.get('priorities', {}).get('P3', 0))} P3, {number(summary.get('priorities', {}).get('Unscored', 0))} unscored. Analyzed coverage: {number(summary.get('analyzedSourceRecords'))} distinct records; {number(summary.get('linkedSourceRecords'))} records linked to active findings.")
    section('Sources used', 'Reference records provide context; only Customer verbatims drive findings and requirements.')
    datasets = data.get('datasets', [])[:8]
    table(['Dataset', 'Role / status', 'Records'], [[short(item.get('name'), 85), f"{text(item.get('type'))} / {text(item.get('status'))}", number(item.get('records'))] for item in datasets], [0.52, 0.32, 0.16]) if datasets else add('No internal datasets are saved for this project.')
    topics = data.get('sourceTopics', [])[:8]
    if topics:
        section('Most observed topics', 'Counts are distinct comments and are not market prevalence estimates.')
        table(['Topic', 'Comments', 'Issues / requests / likes'], [[short(item.get('name'), 100), number(item.get('comments')), f"{number(item.get('negative'))} / {number(item.get('requests'))} / {number(item.get('positive'))}"] for item in topics], [0.55, 0.16, 0.29])

    flow.append(PageBreak())
    section('2. Requirements to decide', 'Requirements are ordered by calculated priority, then score. Missing ratings use the neutral 3/5 default until changed by the PM.')
    requirements = data.get('requirements', [])[:10]
    if requirements:
        table(['ID / priority', 'Requirement', 'Score', 'Evidence', 'Status'], [[
            f"{text(item.get('id'))}\n{text(item.get('priority'))}", short(item.get('statement'), 210),
            f"{item.get('score'):g}/100" if isinstance(item.get('score'), (int, float)) else 'Not scored',
            text(item.get('evidence')), text(item.get('status')),
        ] for item in requirements], [0.18, 0.44, 0.12, 0.12, 0.14])
    else:
        add('No requirements have been generated. Run feedback analysis from Data Sources first.')
    scoring = data.get('scoring', {})
    weights = scoring.get('weights', {})
    thresholds = scoring.get('thresholds', {})
    section('Scoring rule', 'This is the configured project model, not an official BMW standard.')
    add('Weighted score = sum(weight x rating / 5). ' + ' | '.join(f'{name}: {text(weights.get(key))}%' for key, name in DIMENSIONS) + f". P1 >= {text(thresholds.get('p1'))}; P2 >= {text(thresholds.get('p2'))}; otherwise P3.")
    decisions = data.get('decisions', [])[:6]
    section('Recent PM decisions')
    if decisions:
        table(['Date', 'Action / item', 'Rationale'], [[stamp(item.get('at')), f"{text(item.get('action'))}\n{text(item.get('entityId'))}", short(item.get('rationale'), 240)] for item in decisions], [0.18, 0.30, 0.52])
    else:
        add('No PM decisions have been recorded yet.')

    flow.append(PageBreak())
    section('3. Evidence behind the recommendations', 'Findings are AI-organized signals linked to source records. Inspect the original records before making a product decision.')
    findings = data.get('findings', [])[:8]
    if findings:
        table(['ID / category', 'Finding and customer need', 'Sources', 'Strength'], [[
            f"{text(item.get('id'))}\n{short(item.get('category'), 55)}", short(item.get('summary'), 180) + '\nNeed: ' + short(item.get('need'), 140),
            number(item.get('sourceCount')), text(item.get('strength')),
        ] for item in findings], [0.18, 0.56, 0.12, 0.14])
    else:
        add('No findings have been saved for this project.')
    requests = data.get('evidenceRequests', [])[:6]
    section('Open evidence requests')
    if requests:
        table(['Requirement', 'Follow-up needed'], [[text(item.get('requirementId')), short(item.get('text'), 330)] for item in requests], [0.22, 0.78])
    else:
        add('No open evidence requests.')
    section('Interpretation notes')
    add('Customer comments, issue labels, requests, likes, and topic counts come from the supplied source records. Findings and requirements are AI-assisted proposals and remain subject to PM review. Reference records inform context but are not counted as customer complaints or automatically converted into priorities.')
    add('Traceability: each requirement links to findings, each finding links to source record IDs, and the workspace audit trail records PM changes, approvals, rejections, and evidence requests.', 'BriefSmall')

    def footer(canvas, document):
        canvas.saveState()
        canvas.setStrokeColor(LINE)
        canvas.line(MARGIN, 35, PAGE_WIDTH - MARGIN, 35)
        canvas.setFont('Report', 6.7)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN, 23, 'InsightPilot | ' + short(project.get('derivative'), 60))
        canvas.drawRightString(PAGE_WIDTH - MARGIN, 23, f'Page {document.page} of 3')
        canvas.restoreState()

    output = io.BytesIO()
    document = SimpleDocTemplate(output, pagesize=A4, rightMargin=MARGIN, leftMargin=MARGIN, topMargin=32, bottomMargin=48,
                                 title=f"InsightPilot decision brief - {text(project.get('derivative'))} - {text(project.get('market'))}", author='InsightPilot')
    document.build(flow, onFirstPage=footer, onLaterPages=footer)
    slug = re.sub(r'[^A-Za-z0-9._-]+', '-', f"{text(project.get('derivative'))}-{text(project.get('market'))}").strip('-')[:100] or 'project'
    return output.getvalue(), f'insightpilot-{slug}.pdf'


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
    return build_compact_pdf(data)
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
    label('Original feedback annotations', f"{number(summary.get('annotationRows'))} original annotation rows across {number(summary.get('topics'))} topics; {number(summary.get('inferredTopicComments'))} comments received local text-based topic matches and {number(summary.get('generalFeedbackComments'))} low-confidence comments remain General feedback. Distinct comment counts use the same deduplication as Overview.", 'ReportSmall')
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
        body(f"Showing {len(data['sourceTopics'])} of {number(selection.get('topics'))} topics, ordered by distinct comment count. Workbook categories and local text-based matches are distinguished; ambiguous comments are grouped under General feedback. Negative, positive and request labels come from the supplied workbook, not inferred sentiment.", 'ReportSmall')
        table(['Topic', 'Comments', 'Annotations', 'Topic origin / source labels'], [[
            item.get('name'), number(item.get('comments')), number(item.get('annotations')),
            f"Workbook {number(item.get('sourceComments'))} · Inferred {number(item.get('inferredComments'))} · General {number(item.get('generalComments'))}\nNegative {number(item.get('negative'))} · Positive {number(item.get('positive'))} · Requests {number(item.get('requests'))} · Unknown {number(item.get('unknown'))}",
        ] for item in data['sourceTopics']], [0.30, 0.12, 0.13, 0.45])

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
