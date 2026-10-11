"""Microsoft Agent Framework adapters for the app's focused AI roles."""

import asyncio
import json
from threading import Lock
from types import SimpleNamespace


_AGENT_NAMES = {
    'ExtractionBatch': 'Feedback Extraction Agent',
    'MultiRecordExtraction': 'Feedback Extraction Agent',
    'ClusteringBatch': 'Evidence Clustering Agent',
    'MultiScopeClustering': 'Evidence Clustering Agent',
    'RequirementDraft': 'Requirement Drafting Agent',
    'RequirementDraftBatch': 'Requirement Drafting Agent',
    'AssistantDraft': 'Project Evidence Assistant',
}


def _agent_input(payload, message_type):
    if isinstance(payload, list):
        return [
            message_type(role=item['role'], contents=[item['content']])
            for item in payload
        ]
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, ensure_ascii=False)


async def _run_agent(*, name, model, instructions, payload, schema, options):
    try:
        from agent_framework import Agent, Message
        from agent_framework.openai import OpenAIChatClient
    except ImportError as exc:
        raise RuntimeError(
            'Microsoft Agent Framework is missing. Install requirements.txt.'
        ) from exc

    chat_client = OpenAIChatClient(model=model, timeout=60)
    agent = Agent(client=chat_client, name=name, instructions=instructions)
    async with agent:
        response = await agent.run(
            _agent_input(payload, Message),
            options={**options, 'response_format': schema, 'store': False},
        )

    for message in getattr(response, 'messages', []) or []:
        for content in getattr(message, 'contents', []) or []:
            additional = getattr(content, 'additional_properties', {}) or {}
            if (getattr(content, 'type', None) == 'refusal'
                    or additional.get('model_output_kind') == 'refusal'):
                raise ValueError('model refused the request')
    if getattr(response, 'finish_reason', None) in {'length', 'max_tokens'}:
        raise ValueError('incomplete model response')
    if getattr(response, 'value', None) is None:
        raise ValueError('model returned no structured result')
    return response


class MicrosoftAgentClient:
    """Synchronous bridge that keeps existing validation and test client contracts."""

    def __init__(self):
        self.responses = self
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.reasoning_tokens = 0
        self.lock = Lock()

    def parse(self, *, model, text_format, instructions, input, **options):
        name = _AGENT_NAMES.get(text_format.__name__)
        if name is None:
            raise ValueError('No Microsoft Agent Framework role is configured for this output schema.')
        if 'max_output_tokens' in options:
            options['max_tokens'] = options.pop('max_output_tokens')
        try:
            response = asyncio.run(_run_agent(
                name=name,
                model=model,
                instructions=instructions,
                payload=input,
                schema=text_format,
                options=options,
            ))
        except Exception as error:
            inner = getattr(error, 'inner_exception', None)
            if inner is not None:
                raise inner from None
            raise
        usage = getattr(response, 'usage_details', None)
        input_tokens = getattr(usage, 'input_token_count', 0) or 0
        output_tokens = getattr(usage, 'output_token_count', 0) or 0
        additional = getattr(usage, 'additional_counts', {}) or {}
        reasoning_tokens = (
            additional.get('reasoning_tokens', 0)
            or additional.get('reasoning_output_tokens', 0)
            or 0
        )
        with self.lock:
            self.calls += 1
            self.input_tokens += input_tokens
            self.output_tokens += output_tokens
            self.reasoning_tokens += reasoning_tokens

        return SimpleNamespace(
            status='completed',
            output_parsed=response.value,
            output=[],
            usage=SimpleNamespace(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                output_tokens_details=SimpleNamespace(reasoning_tokens=reasoning_tokens),
            ),
        )
