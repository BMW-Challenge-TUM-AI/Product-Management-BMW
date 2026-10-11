"""Legacy database contract checks use local test fixtures and a deterministic mock."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from src.ai.adapter import adapt_feedback, load_feedback_for_ai
from src.ai.db import (save_run, list_requirements, get_linked_evidence,
                       audit_history, revise_requirement, get_requirement)
from src.ai.scoring import assess_priority
from src.ai import run_ai_pipeline
from src.ai.schemas import (ExtractionBatch, FindingExtraction, ClusteringBatch,
                            SemanticCluster, RequirementDraft)

SOURCE_FIXTURE = [
    {'source_id':'TEST-01','vehicle':'F70','text':'Test feedback about seating comfort.',
     'market':'GB','source_type':'customer_feedback','source_file':'test.xlsx','source_location':'Sheet1!row 2'},
    {'source_id':'TEST-02','vehicle':'F70','text':'Test feedback about back discomfort.',
     'market':'GB','source_type':'customer_feedback','source_file':'test.xlsx','source_location':'Sheet1!row 3'},
    {'source_id':'TEST-03','vehicle':'F70','text':'Test feedback about climate menu access.',
     'market':'GB','source_type':'customer_feedback','source_file':'test.xlsx','source_location':'Sheet1!row 4'},
]


class ContractTestProvider:
    """Return fixed schema-valid values for local contract tests; no model calls."""
    def __init__(self):
        self.responses = self

    def parse(self, *, text_format, input, **kwargs):
        payload = json.loads(input)
        if text_format is ExtractionBatch:
            text = payload['text']
            category = 'Comfort' if 'comfort' in text.lower() or 'discomfort' in text.lower() else 'Usability'
            result = ExtractionBatch(findings=[FindingExtraction(
                finding_type='complaint', category=category,
                summary='Test comfort signal' if category == 'Comfort' else 'Test access signal',
                customer_need='Test need', evidence_quote=text, needs_review=False, uncertainties=[])])
        elif text_format is ClusteringBatch:
            result = ClusteringBatch(clusters=[SemanticCluster(
                title='Test category', summary='Test grouping', category=payload[0]['category'],
                finding_type=payload[0]['finding_type'],
                finding_ids=[finding['finding_id'] for finding in payload], uncertainty='Test only')])
        elif text_format is RequirementDraft:
            result = RequirementDraft(description='Test proposal for review.',
                category=payload['cluster']['category'], rationale='Contract test fixture.',
                confidence='low', assumptions=[], uncertainties=['Test fixture; not customer evidence.'])
        else:
            raise AssertionError('Unknown schema')
        return SimpleNamespace(output_parsed=result, output=[], status='completed')

class StepBIntegrationTests(unittest.TestCase):
    def test_adapter_distinct_feedback_and_provenance(self):
        raw={
            'record_type':'customer_feedback','source_id':'F70-FEEDBACK-X1',
            'vehicle_code':'F70','text_original':'The seat is uncomfortable.',
            'country_code':'GB','feedback_id':'X1','source_file':'f70.xlsx',
            'source_cell':'Feedback_Explorer!I2','source_rows':[2,3],
            'annotations':[
                {'feedback_type':'Complaint','vfc_level_2':'Seats'},
                {'feedback_type':'Complaint','vfc_level_2':'Comfort'}],
        }
        obj=adapt_feedback(raw)
        self.assertEqual(obj['source_id'],'F70-FEEDBACK-X1')
        self.assertEqual(obj['market'],'GB')
        self.assertEqual(obj['metadata']['annotation_count'],2)
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'feedback.jsonl'
            path.write_text(json.dumps(raw)+'\n',encoding='utf-8')
            rows,stats=load_feedback_for_ai(path,country='GB',limit=20)
            self.assertEqual(len(rows),1)
            self.assertEqual(stats['available_nonempty_distinct_records'],1)

    def test_mock_pipeline_and_pm_audit(self):
        result=run_ai_pipeline(SOURCE_FIXTURE,client=ContractTestProvider())
        self.assertEqual(result['validation_errors'],[])
        self.assertEqual(len(result['proposed_requirements']),2)
        self.assertTrue(all(f['evidence_valid'] for f in result['findings']))
        with tempfile.TemporaryDirectory() as td:
            database=Path(td)/'db.sqlite3'
            run_id=save_run(SOURCE_FIXTURE,result,db_path=database,settings={'provider':'contract-test'})
            self.assertTrue(run_id)
            reqs=list_requirements(database)
            self.assertEqual(len(reqs),2)
            requirement=reqs[0]
            rid=requirement['requirement_id']
            evidence=get_linked_evidence(rid,database)
            self.assertTrue(evidence['findings'] and evidence['sources'])
            self.assertIsNone(requirement['priority_assessment']['score'])
            with self.assertRaises(ValueError):
                revise_requirement(rid,actor='PM',action='approve',rationale='Looks good',db_path=database)
            ratings={key:3 for key in ['customer_impact','market_relevance','future_relevance','rough_feasibility']}
            explanations={key:'PM assessment recorded for test verification' for key in ratings}
            scored=revise_requirement(rid,actor='PM',action='score',rationale='Assign scores',
                                      ratings=ratings,score_rationales=explanations,db_path=database)
            self.assertIsInstance(scored['priority_assessment']['score'],float)
            self.assertEqual(scored['status'],'under_review')
            approved=revise_requirement(rid,actor='PM',action='approve',
                                        rationale='Approval transition verified by contract test.',db_path=database)
            self.assertEqual(approved['status'],'approved')
            history=audit_history(rid,database)
            self.assertEqual([e['event_type'] for e in history],
                             ['requirement_proposed','pm_score','pm_approve'])
            self.assertEqual([e['actor_type'] for e in history],['AI','human','human'])
            self.assertEqual(approved['version'],3)
            # Append-only triggers reject SQL updates/deletes.
            conn=sqlite3.connect(database)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute('DELETE FROM audit_events WHERE requirement_id=?',(rid,))
            conn.close()

    def test_cannot_approve_unsupported(self):
        result=run_ai_pipeline(SOURCE_FIXTURE[:1],client=ContractTestProvider())
        result['proposed_requirements'][0]['validation_errors']=['unknown_source_id']
        result['proposed_requirements'][0]['evidence_level']='unsupported'
        with tempfile.TemporaryDirectory() as td:
            db=Path(td)/'pm.sqlite3'
            save_run(SOURCE_FIXTURE[:1],result,db_path=db)
            r=list_requirements(db)[0]
            with self.assertRaises(ValueError):
                revise_requirement(r['requirement_id'],actor='PM',action='approve',
                                   rationale='Try to approve',db_path=db)

    def test_score_requires_documentation(self):
        observations={'auto_ratings':{'customer_frequency':3,'evidence_strength':2},
                      'auto_rating_explanations':{'customer_frequency':'record count','evidence_strength':'source quotes'}}
        with self.assertRaises(ValueError):
            assess_priority(observations,{'customer_impact':4},{})
        incomplete=assess_priority(observations,{}, {})
        self.assertIsNone(incomplete['score'])
        self.assertIn('rough_feasibility',incomplete['missing_factors'])

if __name__=='__main__':
    unittest.main()
