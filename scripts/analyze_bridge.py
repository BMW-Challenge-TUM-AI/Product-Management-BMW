"""JSON stdin/stdout bridge. Credentials remain in the server process."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.backend.services.analysis_service import analyze_records

if __name__ == '__main__':
    streaming = '--stream' in sys.argv

    def emit(data):
        print(json.dumps(data, ensure_ascii=False), flush=True)

    def progress(event):
        emit({'type': 'progress', **event})

    try:
        payload = json.load(sys.stdin)
        records = payload.get('records') if isinstance(payload, dict) else payload
        result = analyze_records(records, on_progress=progress if streaming else None)
        emit({'type': 'result', 'result': result} if streaming else result)
    except ValueError as exc:
        emit({'type': 'error', 'error': str(exc)} if streaming else {'error': str(exc)})
        sys.exit(1)
    except Exception:
        error = 'Analysis failed. Check the server Python dependencies and model configuration.'
        emit({'type': 'error', 'error': error} if streaming else {'error': error})
        sys.exit(1)
