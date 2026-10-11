"""Private local BMW data-library bridge; writes no customer-data artifacts."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.backend.services.bmw_library import RAW, load_scope, manifest
from src.backend.services.source_files import read_source_file


def main():
    request = json.load(sys.stdin)
    if request.get('action') == 'manifest':
        result = manifest()
    elif request.get('action') == 'read-file':
        filename = request.get('file_name')
        if not isinstance(filename, str) or Path(filename).name != filename:
            raise ValueError('Choose a source filename from the project data folder.')
        path = (RAW / filename).resolve()
        if path.parent != RAW.resolve():
            raise ValueError('Source files must be inside the project data folder.')
        result = read_source_file(path)
    elif request.get('action') == 'bootstrap':
        result = load_scope('F70', 'EU')
    elif request.get('action') == 'load':
        result = load_scope(request.get('model_code'), request.get('market_code'))
    else:
        raise ValueError('Choose a supported BMW data-library action.')
    json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as exc:
        json.dump({'error': str(exc)}, sys.stdout)
        sys.exit(1)
    except Exception:
        json.dump({'error': 'Could not read the local BMW source files.'}, sys.stdout)
        sys.exit(1)
