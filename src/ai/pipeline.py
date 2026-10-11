"""End-to-end synchronous pipeline with an injectable client for contract tests."""

from pydantic import ValidationError

from .clustering import cluster_findings, singleton_fallback
from .concurrency import ordered_parallel_map, chunked
from .evidence import validate_finding, validate_requirement
from .errors import provider_error_message
from .extraction import extract_findings, extract_findings_batch
from .requirements import generate_requirements
from .schemas import FeedbackRecord


def run_ai_pipeline(records, *, client=None, workers=1, on_progress=None,
                    extraction_batch_size=1, clustering_batch_size=1, requirement_batch_size=1):
    """Return findings, semantic clusters, draft requirements, and validation errors.

    Pass an OpenAI-compatible client to avoid constructing one here. Without
    one, the OpenAI SDK is imported lazily and reads its key from the process
    environment. This function deliberately does not load a local .env file.
    """
    result = {
        "findings": [], "clusters": [], "proposed_requirements": [],
        "validation_errors": [],
    }

    def add_error(code, **context):
        result["validation_errors"].append({"code": code, **context})

    def report(stage, start, end, label):
        def update(completed, total):
            if on_progress:
                fraction = completed / total if total else 1
                on_progress({
                    'stage': stage, 'progress': round(start + (end - start) * fraction),
                    'message': f'{label}: {completed} of {total}.',
                    'completed': completed, 'total': total,
                })
        return update

    if not isinstance(records, list):
        add_error("invalid_input", reason="records must be a list")
        return result

    valid_records = {}
    duplicate_ids = set()
    for index, raw in enumerate(records):
        try:
            record = FeedbackRecord.model_validate(raw)
        except (ValidationError, TypeError):
            add_error("invalid_record", record_index=index)
            continue
        if record.source_id in valid_records:
            duplicate_ids.add(record.source_id)
            add_error("duplicate_source_id", source_id=record.source_id)
        else:
            valid_records[record.source_id] = record
    for source_id in duplicate_ids:
        valid_records.pop(source_id, None)

    def get_client():
        nonlocal client
        if client is None:
            from .agent_runtime import MicrosoftAgentClient
            client = MicrosoftAgentClient()
        return client

    def extract_one(record):
        if not record.text.strip():
            return (record, None, "empty_feedback", None)
        try:
            extracted = extract_findings(get_client(), record)
        except Exception as exc:
            return (record, None, "extraction_failed", provider_error_message(exc))
        return (record, extracted, None, None)

    def extract_batch(batch):
        nonempty = [record for record in batch if record.text.strip()]
        if len(nonempty) <= 1:
            return [extract_one(record) for record in batch]
        try:
            extracted = extract_findings_batch(get_client(), nonempty)
        except Exception as exc:
            reason = provider_error_message(exc)
            return [(record, None, 'extraction_failed' if record.text.strip() else 'empty_feedback', reason)
                    for record in batch]
        return [(record, extracted[record.source_id], None, None) if record.text.strip()
                else (record, None, 'empty_feedback', None) for record in batch]

    ordered = list(valid_records.values())
    if workers > 1 and any(record.text.strip() for record in ordered):
        get_client()  # Construct the shared client before starting threads.
    extracted_rows = [row for batch in ordered_parallel_map(
        extract_batch, chunked(ordered, extraction_batch_size), workers=workers,
        on_progress=report('extracting', 5, 55, 'Feedback records processed'),
        progress_weight=len) for row in batch]

    for record, extracted, issue, reason in extracted_rows:
        if issue:
            add_error(issue, source_id=record.source_id, reason=reason)
            continue
        if not extracted:
            add_error("no_findings", source_id=record.source_id)
        for extracted_finding in extracted:
            finding = extracted_finding.model_dump()
            finding_id = f"F{len(result['findings']) + 1:04d}"
            finding.update(
                finding_id=finding_id,
                source_id=record.source_id,
                source_reference=record.model_dump(exclude_unset=True),
            )
            if finding["finding_type"] == "unclear":
                finding["needs_review"] = True
            if not validate_finding(finding, valid_records):
                add_error("invalid_evidence_quote", finding_id=finding_id,
                          source_id=record.source_id)
            result["findings"].append(finding)

    # Failed source attribution cannot produce a publishable run. Avoid spending
    # further model calls on grouping and drafting an already invalid batch.
    if any(e['code'] not in {'no_findings'} for e in result['validation_errors']):
        return result
    if not any(f["evidence_valid"] and f["finding_type"] != "unclear" for f in result["findings"]):
        return result
    try:
        result["clusters"] = cluster_findings(
            get_client(), result["findings"], workers=workers,
            on_progress=report('clustering', 55, 70, 'Evidence groups processed'),
            batch_size=clustering_batch_size)
    except Exception as exc:
        add_error("semantic_clustering_failed_fallback_used", reason=provider_error_message(exc))
        result["clusters"] = singleton_fallback(result["findings"])

    if not result["clusters"]:
        return result
    try:
        drafts = generate_requirements(
            get_client(), result["findings"], result["clusters"], workers=workers,
            on_progress=report('generating', 70, 92, 'Requirement drafts prepared'),
            batch_size=requirement_batch_size)
    except Exception as exc:
        add_error("requirement_generation_failed", reason=provider_error_message(exc))
        return result

    findings_by_id = {finding["finding_id"]: finding for finding in result["findings"]}
    for index, draft in enumerate(drafts, start=1):
        requirement = dict(draft)
        requirement["requirement_id"] = f"R{index:04d}"
        errors = validate_requirement(
            requirement, findings_by_id, valid_records, result["clusters"]
        )
        for code in errors:
            add_error(code, requirement_id=requirement["requirement_id"])
        result["proposed_requirements"].append(requirement)
    return result


class AnalysisOrchestrator:
    """Run the guarded extraction, grouping, and drafting stages in order."""

    def __init__(self, client=None):
        self.client = client

    def run(self, records, *, workers=1, on_progress=None,
            extraction_batch_size=1, clustering_batch_size=1, requirement_batch_size=1):
        return run_ai_pipeline(
            records,
            client=self.client,
            workers=workers,
            on_progress=on_progress,
            extraction_batch_size=extraction_batch_size,
            clustering_batch_size=clustering_batch_size,
            requirement_batch_size=requirement_batch_size,
        )
