"""Checks the bounded local voice transcription bridge without a paid API call."""

import base64
from types import SimpleNamespace
from unittest.mock import Mock

from scripts.transcribe_bridge import transcribe


def test_transcribes_bounded_recording():
    create = Mock(return_value=SimpleNamespace(text='  What needs attention?  '))
    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    recording = {'mimeType': 'audio/webm', 'audio': base64.b64encode(b'voice' * 30).decode(), 'language': 'en-US'}

    assert transcribe(recording, client) == {'text': 'What needs attention?'}
    assert create.call_args.kwargs['file'] == ('question.webm', b'voice' * 30, 'audio/webm')
    assert create.call_args.kwargs['model'] == 'gpt-transcribe'
    assert create.call_args.kwargs['languages'] == ['en']
    assert 'BMW' in create.call_args.kwargs['prompt']
    assert 'BMW' in create.call_args.kwargs['keywords']


def test_rejects_invalid_or_oversized_recording_without_api_call():
    create = Mock()
    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))

    assert 'error' in transcribe({'mimeType': 'text/plain', 'audio': 'YQ=='}, client)
    assert 'error' in transcribe({'mimeType': 'audio/webm', 'audio': 'not base64'}, client)
    assert 'error' in transcribe({'mimeType': 'audio/webm', 'audio': base64.b64encode(b'x' * 5_000_001).decode()}, client)
    create.assert_not_called()


def test_rejects_empty_transcript():
    create = Mock(return_value=SimpleNamespace(text='  '))
    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    recording = {'mimeType': 'audio/mp4', 'audio': base64.b64encode(b'voice' * 30).decode()}

    assert 'error' in transcribe(recording, client)
