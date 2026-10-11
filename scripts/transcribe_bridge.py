"""Transcribe one bounded browser recording without exposing the API key."""

import base64
import binascii
import json
import os
import sys


SUFFIXES = {'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav'}
LANGUAGES = {'en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'pl', 'tr', 'sv', 'da', 'no', 'fi', 'cs', 'ro', 'ja', 'ko', 'zh'}


def _language_code(value):
    if not isinstance(value, str):
        return None
    code = value.lower().split('-', 1)[0].strip()
    return code if code in LANGUAGES else None


def _prompt(language):
    prompts = {
        'en': 'BMW product-management question. Preserve product names, model codes, acronyms, and technical terms exactly when spoken. Relevant vocabulary: BMW, BMW iX1, BMW 1 Series, F70, iDrive, ConnectedDrive, infotainment, powertrain, drivetrain, charging, range, battery, driver assistance, climate control, seat ventilation, requirements, evidence, prioritization, customer feedback.',
        'fr': 'Question de gestion produit BMW. Preserve les noms de produits, codes de modèles, acronymes et termes techniques. Vocabulaire possible: BMW, BMW iX1, Série 1, F70, iDrive, ConnectedDrive, infotainment, groupe motopropulseur, recharge, autonomie, batterie, assistance au conducteur, climatisation, exigences, preuves, priorisation, feedback client.',
        'de': 'Frage zum BMW-Produktmanagement. Produktnamen, Modellcodes, Akronyme und technische Begriffe exakt erhalten. Mögliche Begriffe: BMW, BMW iX1, 1er, F70, iDrive, ConnectedDrive, Infotainment, Antriebsstrang, Laden, Reichweite, Batterie, Fahrerassistenz, Klimaanlage, Anforderungen, Evidenz, Priorisierung, Kundenfeedback.',
    }
    return prompts.get(language, prompts['en'])


def transcribe(data, client=None):
    mime_type = data.get('mimeType')
    if mime_type not in SUFFIXES or not isinstance(data.get('audio'), str):
        return {'error': 'Unsupported or missing voice recording.'}
    try:
        audio = base64.b64decode(data['audio'], validate=True)
    except (binascii.Error, ValueError):
        return {'error': 'The voice recording could not be read.'}
    if not 100 <= len(audio) <= 5_000_000:
        return {'error': 'Voice recording must be a short, non-empty question.'}
    if client is None:
        from openai import OpenAI
        client = OpenAI(timeout=35, max_retries=0)
    language = _language_code(data.get('language'))
    model = os.getenv('OPENAI_TRANSCRIPTION_MODEL', 'gpt-transcribe').strip()
    options = {
        'file': (f'question.{SUFFIXES[mime_type]}', audio, mime_type),
        'model': model,
        'prompt': _prompt(language),
    }
    if language:
        if model == 'gpt-transcribe':
            options['languages'] = [language]
        else:
            options['language'] = language
    if model == 'gpt-transcribe':
        options['keywords'] = [
            'BMW', 'BMW iX1', 'BMW 1 Series', 'F70', 'iDrive', 'ConnectedDrive',
            'infotainment', 'powertrain', 'drivetrain', 'charging', 'range',
            'battery', 'driver assistance', 'requirements', 'evidence', 'prioritization',
        ]
    result = client.audio.transcriptions.create(
        **options,
    )
    text = result.text.strip() if isinstance(result.text, str) else ''
    return {'text': text} if text else {'error': 'No speech was detected. Try again.'}


def main():
    try:
        payload = json.loads(sys.stdin.read(7_000_000))
        result = transcribe(payload) if isinstance(payload, dict) else {'error': 'Invalid recording request.'}
    except Exception as error:
        status = getattr(error, 'status_code', None)
        if status == 401:
            message = 'The OpenAI API key was rejected. Check the local server configuration.'
        elif status == 403:
            message = 'The API key cannot use audio transcription. Check its project permissions.'
        elif status == 429:
            message = 'Audio transcription is rate-limited or the API quota is exhausted.'
        elif status in (400, 404):
            message = 'The audio format or transcription model was rejected. Try another browser or model.'
        else:
            message = 'The transcription service could not be reached from the local server. Try again.'
        result = {'error': message}
    print(json.dumps(result))
    return 1 if 'error' in result else 0


if __name__ == '__main__':
    sys.exit(main())
