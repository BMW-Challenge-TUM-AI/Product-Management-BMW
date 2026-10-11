"""Merged three-stage contract tests; no external API calls."""
import json
import unittest
from threading import Barrier, Lock
from types import SimpleNamespace
from unittest.mock import Mock, patch
from src.ai import run_ai_pipeline
from src.ai.schemas import ExtractionBatch, FindingExtraction, ClusteringBatch, SemanticCluster, RequirementDraft
from src.backend.services.analysis_service import analyze_records
from src.ai.concurrency import ordered_parallel_map
from src.ai.requirements import generate_requirements


def extraction(quote='Seats hurt.', kind='complaint'):
    return ExtractionBatch(findings=[FindingExtraction(finding_type=kind, category='Comfort', summary='Seat discomfort', customer_need='Comfort', evidence_quote=quote, needs_review=False, uncertainties=[])])

def grouping(ids=None):
    return ClusteringBatch(clusters=[SemanticCluster(title='Seat comfort', summary='Discomfort', category='Comfort', finding_type='complaint', finding_ids=ids or ['F0001'], uncertainty='')])

def draft():
    return RequirementDraft(description='Improve comfort during extended journeys.', category='Comfort', rationale='Source feedback.', confidence='low', assumptions=[], uncertainties=[])

def client(*values):
    c=Mock();c.responses.parse.side_effect=[v if isinstance(v,Exception) else SimpleNamespace(output_parsed=v,output=[],status='completed') for v in values];return c

def record(text='Seats hurt.', sid='s1', **extra):
    return dict(source_id=sid, vehicle='F70', market='GB', text=text,
                source_type='customer_feedback', **extra)

class PipelineTests(unittest.TestCase):
    def test_three_stages_and_attached_provenance(self):
        c=client(extraction(),draft());r=run_ai_pipeline([record()],client=c)
        self.assertEqual(r['validation_errors'],[])
        self.assertEqual(r['proposed_requirements'][0]['linked_source_ids'],['s1'])
        self.assertEqual(r['proposed_requirements'][0]['decision_status'],'pending')
        self.assertEqual(c.responses.parse.call_count,2)
        self.assertTrue(all(call.kwargs['store'] is False for call in c.responses.parse.call_args_list))
        json.dumps(r)

    def test_empty_and_invalid_inputs_never_call_model(self):
        c=Mock()
        for data in [[],[record(' ')],[{'text':'missing ids'}],[record(),record()],'bad']:
            self.assertEqual(run_ai_pipeline(data,client=c)['proposed_requirements'],[])
        c.responses.parse.assert_not_called()

    def test_empty_input_never_initializes_client(self):
        with patch('openai.OpenAI',side_effect=AssertionError('must not construct')):
            self.assertEqual(run_ai_pipeline([])['validation_errors'],[])

    def test_exact_quotes_in_multiple_languages(self):
        for text in ['Die Sitze sind unbequem.','座椅不舒服。','Les sièges sont inconfortables.']:
            r=run_ai_pipeline([record(text)],client=client(extraction(text),draft()))
            self.assertTrue(r['findings'][0]['evidence_valid'])

    def test_invalid_quotes_are_excluded(self):
        for text in ['seats hurt.','','Invented']:
            c=client(extraction(text));r=run_ai_pipeline([record()],client=c)
            self.assertFalse(r['findings'][0]['evidence_valid']);self.assertEqual(r['clusters'],[])
            self.assertEqual(c.responses.parse.call_count,1)

    def test_unknown_cluster_ids_fall_back_with_uncertainty(self):
        r=run_ai_pipeline([record(),record('Seats hurt.',sid='s2')],client=client(extraction(),extraction(),grouping(['invented']),draft(),draft()))
        self.assertEqual(r['clusters'][0]['source_ids'],['s1'])
        self.assertIn('semantic_clustering_failed_fallback_used',[e['code'] for e in r['validation_errors']])
        self.assertTrue(r['proposed_requirements'][0]['uncertainties'])
        self.assertTrue(r['proposed_requirements'][0]['needs_review'])

    def test_duplicate_assignments_rejected(self):
        r=run_ai_pipeline([record(),record('Seats hurt.',sid='s2')],client=client(extraction(),extraction(),grouping(['F0001','F0001']),draft(),draft()))
        self.assertTrue(r['validation_errors'])

    def test_scope_isolation(self):
        data=[record(),record(sid='s2')];data[1]['market']='FR'
        r=run_ai_pipeline(data,client=client(extraction(),extraction(),draft(),draft()))
        self.assertEqual(len(r['clusters']),2);self.assertEqual({c['market'] for c in r['clusters']},{'GB','FR'})

    def test_generation_failure_retains_findings(self):
        r=run_ai_pipeline([record()],client=client(extraction(),RuntimeError()))
        self.assertEqual(len(r['findings']),1);self.assertEqual(r['proposed_requirements'],[])
        self.assertEqual(r['validation_errors'][0]['code'],'requirement_generation_failed')

    def test_unclear_never_generates_requirements(self):
        c=client(extraction(kind='unclear'));r=run_ai_pipeline([record()],client=c)
        self.assertEqual(r['clusters'],[]);self.assertTrue(r['findings'][0]['needs_review'])

    def test_model_env_is_used(self):
        c=client(extraction(),draft())
        with patch.dict('os.environ',{'OPENAI_MODEL':'configured-model'}):run_ai_pipeline([record()],client=c)
        self.assertTrue(all(call.kwargs['model']=='configured-model' for call in c.responses.parse.call_args_list))

    def test_api_batch_limits_and_scope(self):
        for records in [[],[record()]*51,[record(),dict(record(sid='s2'),market='FR')]]:
            with self.assertRaises(ValueError):analyze_records(records,client=Mock())

    def test_api_rejects_missing_or_synthetic_source_records(self):
        missing_source = record()
        missing_source.pop('source_type')
        synthetic = record(metadata={'synthetic': True})
        for data in ([missing_source], [synthetic],
                     [dict(record(), metadata={'synthetic': True})]):
            with self.assertRaisesRegex(ValueError, 'source-backed'):
                analyze_records(data, client=Mock())

    def test_api_rejects_partial_failures(self):
        with self.assertRaises(ValueError):analyze_records([record()],client=client(RuntimeError()))

    def test_progress_reports_actual_stage_completion(self):
        events=[]
        analyze_records([record()], client=client(extraction(), draft()), on_progress=events.append)
        stages=list(dict.fromkeys(event['stage'] for event in events))
        self.assertEqual(stages, ['extracting', 'clustering', 'generating', 'committing'])
        self.assertEqual([e['completed'] for e in events if e['stage']=='extracting'], [0,1])
        self.assertEqual([e['completed'] for e in events if e['stage']=='generating'], [0,1])
        self.assertEqual([e['progress'] for e in events], sorted(e['progress'] for e in events))

    def test_parallel_work_is_bounded_and_retains_input_order(self):
        barrier=Barrier(3, timeout=2)
        lock=Lock()
        active=0
        peak=0
        events=[]
        def work(value):
            nonlocal active,peak
            with lock:
                active+=1
                peak=max(peak,active)
            barrier.wait()
            with lock: active-=1
            return value*2
        result=ordered_parallel_map(work,range(6),workers=3,on_progress=lambda done,total:events.append((done,total)))
        self.assertEqual(result,[0,2,4,6,8,10])
        self.assertEqual(peak,3)
        self.assertEqual(events,[(i,6) for i in range(7)])

    def test_requirement_calls_run_concurrently_with_ordered_evidence_links(self):
        barrier=Barrier(3, timeout=2)
        c=Mock()
        def parse(**kwargs):
            barrier.wait()
            return SimpleNamespace(output_parsed=draft(),output=[],status='completed')
        c.responses.parse.side_effect=parse
        findings=[{'finding_id':f'F{i}'} for i in range(3)]
        clusters=[{'finding_ids':[f'F{i}'],'source_ids':[f's{i}'],'category':'Comfort'} for i in range(3)]
        results=generate_requirements(c,findings,clusters,workers=3)
        self.assertEqual([r['linked_source_ids'] for r in results],[['s0'],['s1'],['s2']])

    def test_provider_error_is_actionable_and_does_not_expose_raw_details(self):
        AuthenticationError=type('AuthenticationError',(Exception,),{})
        with self.assertRaisesRegex(ValueError,'model API key was rejected') as caught:
            analyze_records([record()],client=client(AuthenticationError('secret details')))
        self.assertNotIn('secret details',str(caught.exception))

if __name__=='__main__':unittest.main()
