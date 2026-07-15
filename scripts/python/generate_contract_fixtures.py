from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from blackbox import AgentRuntime
from blackbox.core.accounting import ModelUsage
from blackbox.core.approvals import ApprovalDecision, ApprovalRequest
from blackbox.core.artifacts import Artifact, ArtifactPage, ArtifactRef
from blackbox.core.errors import (
    AgentRuntimeError,
    CapabilityError,
    ConfigurationError,
    ProviderExecutionError,
    UnsupportedFeatureError,
)
from blackbox.core.events import AgentEvent
from blackbox.core.items import RunItem
from blackbox.core.results import AgentResult, ToolPayload, structured_output
from blackbox.core.serialization import (
    agent_ref_to_dict,
    agent_session_to_dict,
    artifact_ref_to_dict,
    artifact_to_dict,
    event_to_dict,
    invocation_ref_to_dict,
    run_state_to_dict,
    session_ref_to_dict,
)
from blackbox.core.sessions import AgentRef, AgentSession, InvocationRef, SessionRef
from blackbox.core.state import ProviderState, RunState
from blackbox.pricing.catalog import bundled_provider_pricing
from blackbox.providers.catalog import bundled_provider_models
from blackbox.providers.model_adapters.anthropic_messages import AnthropicMessagesProvider
from blackbox.providers.model_adapters.gemini_generate_content import GeminiGenerateContentProvider
from blackbox.providers.model_adapters.openai_responses import OpenAIResponsesProvider
from blackbox.providers.model_adapters.xai_responses import XAIResponsesProvider
from blackbox.runtime.config import RuntimeConfig
from tests.fixtures.fake_anthropic_client import FakeAnthropicClient
from tests.fixtures.fake_gemini_client import FakeGeminiClient
from tests.fixtures.fake_openai_client import FakeOpenAIClient


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--parent-commit", required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    write_json(args.output / "core-contracts.json", core_contracts(args.parent_commit))
    write_json(args.output / "catalogs.json", catalogs(args.parent_commit))
    write_json(
        args.output / "provider-differential.json",
        asyncio.run(provider_differential(args.parent_commit)),
    )


def core_contracts(parent_commit: str) -> dict[str, Any]:
    timestamp = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    event = AgentEvent(
        type="model.completed",
        run_id="run_fixture",
        sequence=2,
        trace_id="trace_fixture",
        span_id="span_fixture",
        provider="openai",
        provider_request_id="req_fixture",
        data={"output_text": "hello"},
        raw={"id": "resp_fixture"},
        id="evt_fixture",
        timestamp=timestamp,
    )
    item = RunItem(
        type="message",
        provider="openai",
        data={"text": "hello"},
        status="completed",
        id="item_fixture",
        raw={"type": "message"},
    )
    provider_state = ProviderState(
        provider="openai",
        previous_response_id="resp_fixture",
        native_history=[{"role": "assistant"}],
        reasoning_state={"signature": "sig"},
        tool_state={"call": "call_1"},
        continuation={"cursor": "cursor_1"},
    )
    run_state = RunState(
        session_id="sess_fixture",
        provider="openai",
        model="gpt-5.4",
        provider_state=provider_state,
        items=[item],
        metadata={"fixture": True},
    )
    session = AgentSession(
        provider="local",
        task="fixture",
        agent_id="agent_fixture",
        model="gpt-5.4",
        status="running",
        metadata={"tenant": "dev"},
        id="sess_fixture",
    )
    agent_ref = AgentRef(provider="local", id="agent_fixture", metadata={"version": 1})
    session_ref = SessionRef(
        provider="local", id="sess_fixture", agent_id="agent_fixture", metadata={"tenant": "dev"}
    )
    invocation_ref = InvocationRef(
        provider="local", session_id="sess_fixture", id="invoke_fixture", metadata={"turn": 1}
    )
    artifact = Artifact(
        type="report",
        name="result.json",
        data={"ok": True},
        metadata={"source": "test"},
        id="art_fixture",
    )
    artifact_ref = ArtifactRef(id="art_fixture", provider="local", uri="artifact://art_fixture")
    approval = ApprovalRequest(
        action="workspace.write",
        reason="sensitive",
        data={"path": "a.txt"},
        id="approval_fixture",
    )
    decision = ApprovalDecision(approved=True, reason="reviewed")
    usage = ModelUsage(
        input_tokens=10,
        output_tokens=5,
        total_tokens=15,
        cached_input_tokens=3,
        cache_read_input_tokens=3,
        reasoning_tokens=2,
        tool_calls=1,
        provider_details={"request_id": "req_fixture"},
    )
    result = AgentResult(
        output={"answer": "hello"},
        text="hello",
        events=[event],
        items=[item],
        artifacts=[artifact],
        payloads=[ToolPayload(tool_name="lookup", payload={"ok": True}, call_id="call_1")],
        provider_state=provider_state,
        metadata={"usage": dataclasses.asdict(usage)},
    )
    runtime_config = RuntimeConfig.from_mapping(
        {"profile": "fast_text", "overrides": {"temperature": 0.2}}, source="fixture"
    )
    output_spec = structured_output(
        {"type": "object", "properties": {"answer": {"type": "string"}}},
        name="fixture_output",
    )

    return {
        "schema_version": 2,
        "generated_by": "python-parent",
        "parent_commit": parent_commit,
        "event": event_to_dict(event, keep_raw=True),
        "run_state": run_state_to_dict(run_state),
        "agent_ref": agent_ref_to_dict(agent_ref),
        "session_ref": session_ref_to_dict(session_ref),
        "invocation_ref": invocation_ref_to_dict(invocation_ref),
        "session": agent_session_to_dict(session),
        "artifact_ref": artifact_ref_to_dict(artifact_ref),
        "artifact": artifact_to_dict(artifact),
        "artifact_page": jsonable(ArtifactPage(items=[artifact])),
        "approval_request": jsonable(approval),
        "approval_decision": jsonable(decision),
        "usage": jsonable(usage),
        "result": {
            "output": result.output,
            "text": result.text,
            "event_ids": [entry.id for entry in result.events],
            "item_ids": [entry.id for entry in result.items],
            "artifact_ids": [entry.id for entry in result.artifacts],
            "payloads": jsonable(result.payloads),
            "provider_state": jsonable(result.provider_state),
            "metadata": result.metadata,
        },
        "runtime_config": {
            "profile_name": runtime_config.profile_name,
            "overrides": dict(runtime_config.overrides),
            "source": runtime_config.source,
            "kwargs": runtime_config.to_kwargs(surface="model"),
            "description": runtime_config.describe(),
        },
        "output_spec": jsonable(output_spec),
        "error_semantics": [
            error_semantics(error)
            for error in (
                AgentRuntimeError("runtime"),
                ConfigurationError("config"),
                CapabilityError("capability"),
                UnsupportedFeatureError("unsupported"),
                ProviderExecutionError("provider"),
            )
        ],
    }


def catalogs(parent_commit: str) -> dict[str, Any]:
    models = [compact(dataclasses.asdict(model)) for model in bundled_provider_models()]
    normalized_models = [
        compact(
            {
                "provider": model["provider"],
                "id": model["model"],
                "display_name": model.get("display_name"),
                "family": model.get("family"),
                "aliases": model["aliases"],
                "status": model["lifecycle"],
                "replacement_model": model.get("replacement_model"),
                "modalities": model["modalities"],
                "context_window": model.get("context_window"),
                "max_output_tokens": model.get("max_output_tokens"),
                "source": model.get("source"),
                "catalog_version": model.get("catalog_version"),
                "retrieved_at": model.get("retrieved_at"),
                "source_url": model.get("source_url"),
                "metadata": model["metadata"],
            }
        )
        for model in models
    ]
    prices = [compact(dataclasses.asdict(price)) for price in bundled_provider_pricing()]
    normalized_prices = [
        {
            "provider": price["provider"],
            "model": price["model"],
            "currency": "USD",
            "rates": compact(
                {
                    "input_per_million": price["input_per_million"],
                    "output_per_million": price["output_per_million"],
                    "cache_read_per_million": price.get("cache_read_input_per_million")
                    if price.get("cache_read_input_per_million") is not None
                    else price.get("cached_input_per_million"),
                    "cache_creation_per_million": price.get("cache_creation_input_per_million")
                    if price.get("cache_creation_input_per_million") is not None
                    else price["input_per_million"],
                }
            ),
            "source": price["source"],
            "version": price["catalog_version"],
            "effective_at": f'{price["retrieved_at"]}T00:00:00.000Z',
            "metadata": {"replaceable": True},
        }
        for price in prices
    ]
    return {
        "schema_version": 1,
        "generated_by": "python-parent",
        "parent_commit": parent_commit,
        "models": normalized_models,
        "pricing": normalized_prices,
    }


async def provider_differential(parent_commit: str) -> dict[str, Any]:
    scenarios = []
    scenarios.append(await openai_scenario("openai", OpenAIResponsesProvider))
    scenarios.append(await openai_scenario("xai", XAIResponsesProvider))
    scenarios.append(await anthropic_scenario())
    scenarios.append(await gemini_scenario())
    return {
        "schema_version": 1,
        "generated_by": "python-parent",
        "parent_commit": parent_commit,
        "scenarios": scenarios,
    }


async def openai_scenario(provider_id: str, provider_class: type[Any]) -> dict[str, Any]:
    model = "gpt-5.4" if provider_id == "openai" else "grok-4.3"
    response = {
        "id": f"resp_{provider_id}",
        "output": [
            {
                "id": f"call_{provider_id}",
                "type": "function_call",
                "status": "completed",
                "name": "lookup",
                "call_id": f"tool_{provider_id}",
                "arguments": '{"id":"42"}',
            },
            {
                "id": f"msg_{provider_id}",
                "type": "message",
                "status": "completed",
                "content": [{"type": "output_text", "text": f"{provider_id} answer"}],
            },
        ],
        "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
    }
    wire = [
        {"type": "response.created", "response": {"id": response["id"]}},
        {"type": "response.output_item.added", "item": response["output"][0]},
        {"type": "response.output_text.delta", "delta": f"{provider_id} answer"},
        {"type": "response.output_item.done", "item": response["output"][0]},
        {"type": "response.completed", "response": response},
    ]
    client = FakeOpenAIClient()
    client.queue(events=[namespace(event) for event in wire], final_response=namespace(response))
    runtime = AgentRuntime()
    runtime.registry.register_model(provider_class(client=client))
    result = await runtime.models.run(provider=f"{provider_id}/{model}", input="lookup 42")
    return {
        "provider": provider_id,
        "model": model,
        "wire_events": wire,
        "final_response": response,
        "expected": project_result(result),
    }


async def anthropic_scenario() -> dict[str, Any]:
    model = "claude-haiku-4-5-20251001"
    wire = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_anthropic",
                "model": model,
                "usage": {"input_tokens": 5, "output_tokens": 0},
            },
        },
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "tool_use", "id": "tool_anthropic", "name": "lookup"},
        },
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "input_json_delta", "partial_json": '{"id":"42"}'},
        },
        {"type": "content_block_stop", "index": 0},
        {
            "type": "content_block_start",
            "index": 1,
            "content_block": {"type": "text", "text": ""},
        },
        {
            "type": "content_block_delta",
            "index": 1,
            "delta": {"type": "text_delta", "text": "anthropic answer"},
        },
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "usage": {"output_tokens": 2}},
        {"type": "message_stop"},
    ]
    final = {
        "id": "msg_anthropic",
        "role": "assistant",
        "content": [
            {"type": "tool_use", "id": "tool_anthropic", "name": "lookup", "input": {"id": "42"}},
            {"type": "text", "text": "anthropic answer"},
        ],
        "usage": {"input_tokens": 5, "output_tokens": 2},
    }
    client = FakeAnthropicClient()
    client.queue(events=[namespace(event) for event in wire], final_message=namespace(final))
    runtime = AgentRuntime()
    runtime.registry.register_model(AnthropicMessagesProvider(client=client))
    result = await runtime.models.run(provider="anthropic", model=model, input="lookup 42")
    return {
        "provider": "anthropic",
        "model": model,
        "wire_events": wire,
        "final_response": final,
        "expected": project_result(result),
    }


async def gemini_scenario() -> dict[str, Any]:
    model = "gemini-2.5-flash"
    wire = [
        {
            "responseId": "resp_google",
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [
                            {"functionCall": {"id": "tool_google", "name": "lookup", "args": {"id": "42"}}},
                            {"text": "google answer"},
                        ],
                    }
                }
            ],
            "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 2, "totalTokenCount": 9},
        }
    ]
    sdk_chunks = [namespace(camel_to_snake(chunk)) for chunk in wire]
    client = FakeGeminiClient()
    client.queue(sdk_chunks)
    runtime = AgentRuntime()
    runtime.registry.register_model(GeminiGenerateContentProvider(client=client))
    result = await runtime.models.run(provider="google", model=model, input="lookup 42")
    return {
        "provider": "google",
        "model": model,
        "wire_events": wire,
        "expected": project_result(result),
    }


def project_result(result: Any) -> dict[str, Any]:
    usage = dict(result.metadata.get("usage") or {})
    state = result.provider_state
    items: list[dict[str, Any]] = []
    for event in result.events:
        item = event.data.get("item")
        if (
            isinstance(item, RunItem)
            and item.type == "function_call"
            and not any(entry["id"] == item.id for entry in items)
        ):
            items.append(
                {
                    "id": item.id,
                    "type": item.type,
                    "provider": item.provider,
                    "name": item.data.get("name"),
                    "call_id": item.data.get("call_id"),
                }
            )
    event_types = [event.type for event in result.events]
    return {
        "output_text": result.text,
        "events": {
            "request_started": "model.request.started" in event_types,
            "text_delta": "model.text.delta" in event_types,
            "reasoning_delta": "model.reasoning.delta" in event_types,
            "completed": "model.completed" in event_types,
        },
        "items": items,
        "usage": {
            key: usage.get(key, 0)
            for key in (
                "input_tokens",
                "output_tokens",
                "total_tokens",
                "cached_input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "reasoning_tokens",
            )
        },
        "provider_state": compact(
            {
                "provider": state.provider if state else None,
                "previous_response_id": state.previous_response_id if state else None,
            }
        ),
    }


def error_semantics(error: Exception) -> dict[str, Any]:
    cls = type(error)
    return {
        "name": cls.__name__,
        "message": str(error),
        "is_agent_runtime_error": isinstance(error, AgentRuntimeError),
        "is_configuration_error": isinstance(error, ConfigurationError),
        "is_capability_error": isinstance(error, CapabilityError),
    }


def namespace(value: Any) -> Any:
    if isinstance(value, dict):
        return SimpleNamespace(**{key: namespace(child) for key, child in value.items()})
    if isinstance(value, list):
        return [namespace(child) for child in value]
    return value


def camel_to_snake(value: Any) -> Any:
    aliases = {
        "responseId": "response_id",
        "usageMetadata": "usage_metadata",
        "promptTokenCount": "prompt_token_count",
        "candidatesTokenCount": "candidates_token_count",
        "totalTokenCount": "total_token_count",
        "functionCall": "function_call",
    }
    if isinstance(value, dict):
        return {aliases.get(key, key): camel_to_snake(child) for key, child in value.items()}
    if isinstance(value, list):
        return [camel_to_snake(child) for child in value]
    return value


def jsonable(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {field.name: jsonable(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, dict):
        return {str(key): jsonable(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(child) for child in value]
    if isinstance(value, SimpleNamespace):
        return {key: jsonable(child) for key, child in vars(value).items()}
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def compact(value: dict[str, Any]) -> dict[str, Any]:
    return {key: child for key, child in value.items() if child is not None}


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(jsonable(value), indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
