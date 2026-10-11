"""Citation checks for the local assistant; no provider request is made."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from src.ai.assistant import AssistantDraft, AssistantError, Citation, answer_question


class AssistantCitationTests(unittest.TestCase):
    def answer(self, quote, source_id='S1'):
        client = Mock()
        client.responses.parse.return_value = SimpleNamespace(
            status='completed',
            output_parsed=AssistantDraft(
                answer='One record discusses seat support.',
                citations=[Citation(source_id=source_id, quote=quote)],
                uncertainty='Only one record.',
            ),
            usage=None,
        )
        payload = {
            'question': 'What do customers say about seats?',
            'project': {'id': 'p1', 'derivative': 'G60', 'market': 'Germany'},
            'requirements': [], 'findings': [],
            'sources': [{'id': 'S1', 'text': 'The seats are supportive on long trips.'}],
        }
        return answer_question(payload, client=client)

    def test_recovers_cosmetic_quote_differences_as_exact_source_text(self):
        result = self.answer('"the seats  are supportive..."')
        self.assertEqual(result['citations'], [
            {'source_id': 'S1', 'quote': 'The seats are supportive'},
        ])

    def test_rejects_invented_and_misattributed_quotes(self):
        for quote, source_id in [('The seats are uncomfortable.', 'S1'),
                                 ('The seats are supportive', 'S2')]:
            with self.subTest(quote=quote, source_id=source_id):
                with self.assertRaises(AssistantError) as error:
                    self.answer(quote, source_id)
                self.assertEqual(error.exception.code, 'unsupported_citation')


if __name__ == '__main__':
    unittest.main()
