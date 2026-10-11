"""Batching contracts: completeness, attribution, scope and measured request count."""

import json
import unittest
from collections import Counter
from threading import Lock
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.ai import run_ai_pipeline
from src.ai.clustering import cluster_findings
from src.ai.extraction import extract_findings_batch, parse_model
from src.ai.requirements import generate_requirements
from src.ai.schemas import (FeedbackRecord, FindingExtraction, ExtractionBatch,
                            RecordExtraction, MultiRecordExtraction, ClusteringBatch,
                            SemanticCluster, ScopedClustering, MultiScopeClustering,
                            RequirementDraft, ClusterRequirementDraft, RequirementDraftBatch)
from src.backend.services.analysis_service import analyze_records


def source(index):
    return FeedbackRecord(source_id=f'TEST-{index}', vehicle='F70', market='GB',
                          text=f'Contract test source text {index}.', source_type='customer_feedback')


def extracted(record):
    index = int(record['source_id'].split('-')[-1])
    return FindingExtraction(
        finding_type='complaint' if index % 2 else 'positive_feedback',
        category=['Comfort','UX','Interior','Storage','Technology'][index % 5],
        summary=record['text'], customer_need='Contract test need',
        evidence_quote=record['text'], needs_review=False, uncertainties=[])


def requirement(category):
    return RequirementDraft(description='Contract test outcome.', category=category,
                            rationale='Contract test rationale.', confidence='low',
                            assumptions=[], uncertainties=[])


def response(value):
    return SimpleNamespace(output_parsed=value, output=[], status='completed')


class BatchContractProvider:
    """A deterministic schema provider restricted to this test suite."""
    def __init__(self):
        self.responses = self
        self.calls = []
        self.lock = Lock()

    def parse(self, *, text_format, input, **kwargs):
        data = json.loads(input)
        with self.lock:
            self.calls.append(text_format.__name__)
        if text_format is ExtractionBatch:
            return response(ExtractionBatch(findings=[extracted(data)]))
        if text_format is MultiRecordExtraction:
            # Reverse every model response to exercise ID-based attribution.
            return response(MultiRecordExtraction(records=[RecordExtraction(
                source_id=record['source_id'], findings=[extracted(record)])
                for record in reversed(data['records'])]))
        def group(findings):
            return [SemanticCluster(title=finding['summary'], summary=finding['summary'],
                                    category=finding['category'], finding_type=finding['finding_type'],
                                    finding_ids=[finding['finding_id']], uncertainty='')
                    for finding in findings]
        if text_format is ClusteringBatch:
            return response(ClusteringBatch(clusters=group(data)))
        if text_format is MultiScopeClustering:
            return response(MultiScopeClustering(groups=[ScopedClustering(
                scope_id=scope['scope_id'], clusters=group(scope['findings']))
                for scope in reversed(data['groups'])]))
        if text_format is RequirementDraft:
            return response(requirement(data['cluster']['category']))
        if text_format is RequirementDraftBatch:
            return response(RequirementDraftBatch(drafts=[ClusterRequirementDraft(
                cluster_id=item['cluster']['cluster_id'],
                **requirement(item['cluster']['category']).model_dump())
                for item in reversed(data['clusters'])]))
        raise AssertionError(f'Unexpected schema: {text_format}')


class FastAnalysisTests(unittest.TestCase):
    def test_fifty_sources_use_fourteen_requests_with_all_evidence_preserved(self):
        records = [source(index).model_dump() for index in range(50)]
        legacy = BatchContractProvider()
        expected = run_ai_pipeline(records, client=legacy)
        fast = BatchContractProvider()
        events = []
        actual = run_ai_pipeline(records, client=fast, workers=3, extraction_batch_size=10,
                                 clustering_batch_size=8, requirement_batch_size=8,
                                 on_progress=events.append)
        self.assertEqual(actual, expected)
        self.assertEqual(len(legacy.calls), 110)
        self.assertEqual(Counter(fast.calls), {
            'MultiRecordExtraction':5, 'MultiScopeClustering':2, 'RequirementDraftBatch':7})
        self.assertEqual(len(actual['findings']), 50)
        self.assertEqual(len(actual['proposed_requirements']), 50)
        self.assertEqual([f['source_id'] for f in actual['findings']], [r['source_id'] for r in records])
        self.assertTrue(all(f['evidence_valid'] for f in actual['findings']))
        completed = [event['completed'] for event in events if event['stage']=='extracting']
        self.assertEqual(completed, [0,10,20,30,40,50])
        self.assertEqual(next(e for e in reversed(events) if e['stage']=='generating')['completed'], 50)

    def test_service_uses_fast_batching_by_default(self):
        provider = BatchContractProvider()
        result = analyze_records([source(i).model_dump() for i in range(50)], client=provider)
        self.assertEqual(result['metrics']['api_calls'], 14)
        self.assertEqual(result['metrics']['extraction_batch_size'], 10)

    def test_extraction_rejects_missing_duplicate_and_unknown_source_ids(self):
        records = [source(1), source(2)]
        valid = [RecordExtraction(source_id=r.source_id,findings=[extracted(r.model_dump())]) for r in records]
        for entries in [valid[:1], [valid[0],valid[0]], [valid[0],valid[1].model_copy(update={'source_id':'unknown'})]]:
            client = Mock()
            client.responses.parse.return_value = response(MultiRecordExtraction(records=entries))
            with self.assertRaisesRegex(ValueError,'source IDs'):
                extract_findings_batch(client, records)

    def test_extraction_rejects_quote_from_another_source(self):
        first, second = source(1), source(2)
        stolen = extracted(second.model_dump())
        client = Mock()
        client.responses.parse.return_value = response(MultiRecordExtraction(records=[
            RecordExtraction(source_id=first.source_id, findings=[stolen]),
            RecordExtraction(source_id=second.source_id, findings=[])]))
        with self.assertRaisesRegex(ValueError,'attributed source'):
            extract_findings_batch(client,[first,second])

    def test_empty_findings_still_require_every_source_to_be_accounted_for(self):
        records = [source(1),source(2)]
        client = Mock()
        client.responses.parse.return_value = response(MultiRecordExtraction(records=[
            RecordExtraction(source_id=r.source_id,findings=[]) for r in records]))
        result = run_ai_pipeline([r.model_dump() for r in records], client=client, extraction_batch_size=10)
        self.assertEqual(result['findings'], [])
        self.assertEqual(len(result['validation_errors']), 2)
        self.assertEqual(client.responses.parse.call_count, 1)

    def test_requirement_batch_rejects_missing_duplicate_unknown_or_wrong_category(self):
        clusters = [{'cluster_id':f'C{i}', 'category':'Comfort', 'finding_ids':[f'F{i}'],
                     'source_ids':[f'S{i}']} for i in range(2)]
        findings = [{'finding_id':f'F{i}', 'source_id':f'S{i}'} for i in range(2)]
        valid = [ClusterRequirementDraft(cluster_id=f'C{i}',**requirement('Comfort').model_dump()) for i in range(2)]
        invalid = [valid[:1], [valid[0],valid[0]],
                   [valid[0],valid[1].model_copy(update={'cluster_id':'unknown'})],
                   [valid[0],valid[1].model_copy(update={'category':'UX'})]]
        for drafts in invalid:
            client = Mock()
            client.responses.parse.return_value = response(RequirementDraftBatch(drafts=drafts))
            with self.assertRaises(ValueError):
                generate_requirements(client,findings,clusters,batch_size=8)

    def test_clustering_rejects_cross_scope_finding_ids(self):
        provider = BatchContractProvider()
        findings = run_ai_pipeline([source(i).model_dump() for i in (1,11,2,12)],client=provider)['findings']
        client = Mock()
        def bad_parse(**kwargs):
            data = json.loads(kwargs['input'])
            groups = []
            for index, scope in enumerate(data['groups']):
                wrong = data['groups'][1-index]['findings']
                groups.append(ScopedClustering(scope_id=scope['scope_id'], clusters=[SemanticCluster(
                    title='Test',summary='Test',category=scope['findings'][0]['category'],
                    finding_type=scope['findings'][0]['finding_type'],
                    finding_ids=[f['finding_id'] for f in wrong],uncertainty='')]))
            return response(MultiScopeClustering(groups=groups))
        client.responses.parse.side_effect = bad_parse
        with self.assertRaisesRegex(ValueError,'assignments'):
            cluster_findings(client,findings,batch_size=8)

    def test_gpt5_mini_uses_supported_low_reasoning_without_changing_other_models(self):
        client = Mock()
        client.responses.parse.return_value = response(ExtractionBatch(findings=[]))
        with patch.dict('os.environ',{'OPENAI_MODEL':'gpt-5-mini','OPENAI_REASONING_EFFORT':'low'}):
            parse_model(client,ExtractionBatch,'Test',{})
        self.assertEqual(client.responses.parse.call_args.kwargs['reasoning'], {'effort':'low'})
        with patch.dict('os.environ',{'OPENAI_MODEL':'other-model'}):
            parse_model(client,ExtractionBatch,'Test',{})
        self.assertNotIn('reasoning',client.responses.parse.call_args.kwargs)
