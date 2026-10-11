"""Bounded JSON stdin/stdout bridge for the local read-only assistant."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> int:
    try:
        from src.ai.assistant import AssistantError, answer_question
    except ImportError:
        print(json.dumps({'error': 'The assistant dependencies are unavailable. Install requirements.txt in the server Python environment.',
                          'code': 'missing_configuration', 'retryable': False}))
        return 1
    try:
        raw = sys.stdin.read(1_000_001)
        if len(raw.encode('utf-8')) > 1_000_000:
            raise AssistantError('The assistant request is too large. Ask about a specific topic or requirement.', 'context_too_large')
        result = answer_question(json.loads(raw))
    except AssistantError as error:
        result = error.as_dict()
    except (json.JSONDecodeError, RecursionError):
        result = {'error': 'The assistant request could not be read. Refresh the project and retry.',
                  'code': 'invalid_request', 'retryable': False}
    except ImportError:
        result = {'error': 'The assistant dependencies are unavailable. Install requirements.txt in the server Python environment.',
                  'code': 'missing_configuration', 'retryable': False}
    except Exception:
        # Provider bodies, exception text and configuration never reach the browser.
        result = {'error': 'The assistant is temporarily unavailable. Retry, or use the local project summary.',
                  'code': 'unavailable', 'retryable': True}
    print(json.dumps(result, ensure_ascii=False))
    return 1 if 'error' in result else 0


if __name__ == '__main__':
    sys.exit(main())
