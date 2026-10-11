"""Provider diagnostics that never include credentials or customer text."""


def provider_error_message(error):
    messages = {
        'AuthenticationError': 'The model API key was rejected. Check OPENAI_API_KEY and restart the app.',
        'PermissionDeniedError': 'The model API key does not have access to the configured model.',
        'RateLimitError': 'The model service rate limit or account quota was reached. Check account limits before retrying.',
        'APITimeoutError': 'The model service timed out before completing a response.',
        'APIConnectionError': 'The server could not connect to the model service. Check its network connection.',
        'NotFoundError': 'The configured model could not be found. Check OPENAI_MODEL.',
        'BadRequestError': 'The model service rejected the request. Check the configured model and structured output support.',
        'InternalServerError': 'The model service returned a server error. Retry after the service recovers.',
    }
    # These messages are authored by our validators and never interpolate input.
    safe_validation_messages = {
        'incomplete model response', 'model refused the request',
        'model returned no structured result',
        'Extraction contains missing, duplicate or unknown source IDs.',
        'Extraction quote does not match its attributed source.',
        'Clustering contains missing, duplicate or unknown scope IDs.',
        'cluster assignments contain missing, duplicate, or unknown IDs',
        'cluster category or finding type does not match its evidence',
        'Requirement batch contains missing, duplicate or unknown cluster IDs.',
        'Requirement category does not match its cluster.',
        'OPENAI_REASONING_EFFORT must be minimal, low, medium or high for gpt-5-mini.',
    }
    if type(error) is ValueError and str(error) in safe_validation_messages:
        return str(error)
    if type(error).__name__ == 'ValidationError':
        return 'The model returned fields that do not match the required output schema.'
    return messages.get(type(error).__name__, 'The model response could not be completed or validated.')
