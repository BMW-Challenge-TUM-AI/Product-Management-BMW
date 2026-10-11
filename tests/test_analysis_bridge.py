"""Validate streamed and legacy bridge protocols without model requests."""

import io
import json
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch


BRIDGE = Path(__file__).resolve().parents[1] / 'scripts' / 'analyze_bridge.py'


class AnalysisBridgeTests(unittest.TestCase):
    def invoke(self, *, streaming, implementation):
        output = io.StringIO()
        with patch('sys.argv', [str(BRIDGE)] + (['--stream'] if streaming else [])), \
                patch('sys.stdin', io.StringIO('{"records":[]}')), \
                patch('sys.stdout', output), \
                patch('src.backend.services.analysis_service.analyze_records', side_effect=implementation):
            try:
                runpy.run_path(str(BRIDGE), run_name='__main__')
            except SystemExit as exc:
                self.assertEqual(exc.code, 1)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_stream_orders_progress_before_complete_result(self):
        def analyze(records, *, on_progress):
            on_progress({'stage':'extracting','progress':55,'message':'1 of 1.'})
            return {'findings':[], 'proposed_requirements':[]}
        events = self.invoke(streaming=True, implementation=analyze)
        self.assertEqual([event['type'] for event in events], ['progress','result'])
        self.assertEqual(events[1]['result']['findings'], [])

    def test_legacy_json_is_preserved(self):
        def analyze(records, *, on_progress):
            self.assertIsNone(on_progress)
            return {'findings':[]}
        self.assertEqual(self.invoke(streaming=False, implementation=analyze), [{'findings':[]}])

    def test_stream_returns_terminal_error_after_progress(self):
        def analyze(records, *, on_progress):
            on_progress({'stage':'extracting','progress':5,'message':'Starting.'})
            raise ValueError('Source validation failed.')
        events = self.invoke(streaming=True, implementation=analyze)
        self.assertEqual([event['type'] for event in events], ['progress','error'])
        self.assertEqual(events[-1]['error'], 'Source validation failed.')
