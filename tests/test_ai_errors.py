"""Keep model failures actionable without exposing source text or credentials."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from pydantic import ValidationError

from src.ai.errors import provider_error_message
from src.ai.schemas import (
    ExtractionBatch, FindingExtraction, MultiRecordExtraction,
    RecordExtraction, RequirementDraft,
)
from src.backend.services.analysis_service import analyze_records


def record(source_id):
    return dict(source_id=source_id, vehicle='F70', market='GB',
                text=f'Private source text for {source_id}.',
                source_type='customer_feedback')


def finding(quote):
    return FindingExtraction(
        finding_type='complaint', category='Comfort', summary='Seat discomfort',
        customer_need='Comfortable seats', evidence_quote=quote,
        needs_review=False, uncertainties=[])


def provider(*values):
    client = Mock()
    client.responses.parse.side_effect = [
        value if isinstance(value, Exception) else
        SimpleNamespace(output_parsed=value, output=[], status='completed')
        for value in values
    ]
    return client


class SafeDiagnosticsTests(unittest.TestCase):
    def test_attribution_failures_keep_the_validator_explanation(self):
        messages = [
            'Extraction contains missing, duplicate or unknown source IDs.',
            'Extraction quote does not match its attributed source.',
            'Clustering contains missing, duplicate or unknown scope IDs.',
            'cluster assignments contain missing, duplicate, or unknown IDs',
            'Requirement batch contains missing, duplicate or unknown cluster IDs.',
            'Requirement category does not match its cluster.',
        ]
        for message in messages:
            with self.subTest(message=message):
                self.assertEqual(provider_error_message(ValueError(message)), message)

    def test_only_exact_authored_value_errors_are_exposed(self):
        approved = 'Extraction quote does not match its attributed source.'
        for error in [ValueError('Private feedback and secret API details'),
                      ValueError(approved + ' Private feedback'),
                      RuntimeError(approved)]:
            with self.subTest(error=type(error).__name__, message=str(error)):
                self.assertEqual(provider_error_message(error),
                                 'The model response could not be completed or validated.')

    def test_schema_error_does_not_expose_the_invalid_model_value(self):
        invalid = finding('Private quote').model_dump()
        invalid['category'] = 'Private source text or credential'
        with self.assertRaises(ValidationError) as caught:
            FindingExtraction.model_validate(invalid)
        self.assertEqual(provider_error_message(caught.exception),
                         'The model returned fields that do not match the required output schema.')

    def test_provider_errors_do_not_expose_raw_request_details(self):
        for name, expected in [
            ('AuthenticationError', 'API key was rejected'),
            ('RateLimitError', 'rate limit or account quota'),
            ('APITimeoutError', 'timed out'),
        ]:
            error_type = type(name, (Exception,), {})
            message = provider_error_message(error_type('Private feedback; credential=secret'))
            with self.subTest(name=name):
                self.assertIn(expected, message)
                self.assertNotIn('Private feedback', message)
                self.assertNotIn('credential=secret', message)

    def test_missing_source_reports_extraction_stage_and_stops_downstream_calls(self):
        first, second = record('s1'), record('s2')
        client = provider(MultiRecordExtraction(records=[
            RecordExtraction(source_id='s1', findings=[finding(first['text'])]),
        ]))
        with self.assertRaises(ValueError) as caught:
            analyze_records([first, second], client=client)
        message = str(caught.exception)
        self.assertIn('AI analysis failed (extraction_failed)', message)
        self.assertEqual(message.count('Extraction contains missing, duplicate or unknown source IDs.'), 1)
        self.assertIn('No results were saved.', message)
        self.assertNotIn(first['text'], message)
        self.assertEqual(client.responses.parse.call_count, 1)

    def test_cross_source_quote_reports_attribution_failure_without_source_text(self):
        first, second = record('s1'), record('s2')
        client = provider(MultiRecordExtraction(records=[
            RecordExtraction(source_id='s1', findings=[finding(second['text'])]),
            RecordExtraction(source_id='s2', findings=[]),
        ]))
        with self.assertRaises(ValueError) as caught:
            analyze_records([first, second], client=client)
        message = str(caught.exception)
        self.assertIn('AI analysis failed (extraction_failed)', message)
        self.assertIn('Extraction quote does not match its attributed source.', message)
        self.assertNotIn(second['text'], message)
        self.assertEqual(client.responses.parse.call_count, 1)

    def test_requirement_category_failure_reports_generation_stage(self):
        source = record('s1')
        client = provider(
            ExtractionBatch(findings=[finding(source['text'])]),
            RequirementDraft(description='Improve comfort.', category='UX',
                             rationale='Evidence.', confidence='low',
                             assumptions=[], uncertainties=[]),
        )
        with self.assertRaises(ValueError) as caught:
            analyze_records([source], client=client)
        message = str(caught.exception)
        self.assertIn('AI analysis failed (requirement_generation_failed)', message)
        self.assertIn('Requirement category does not match its cluster.', message)
        self.assertIn('No results were saved.', message)
        self.assertNotIn(source['text'], message)
        self.assertEqual(client.responses.parse.call_count, 2)


if __name__ == '__main__':
    unittest.main()
