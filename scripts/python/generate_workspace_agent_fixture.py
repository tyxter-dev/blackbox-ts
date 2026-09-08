"""Generate real Python ZIP samples via generate-python-fixtures.mjs."""

import argparse
import base64
import json
import os
import subprocess
import tempfile
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import blackbox
from blackbox.workspace_agents.package import (
    pack_workspace_agent_package,
    save_workspace_agent_package,
)
from blackbox.workspace_agents.permissions import ConnectorSpec, ToolPermission
from blackbox.workspace_agents.spec import WorkspaceAgentSpec, WorkspaceAgentVersion

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=Path)
parser.add_argument("--parent-commit", required=True)
args = parser.parse_args()
parent = Path(blackbox.__file__).resolve().parents[2]
pin = subprocess.check_output(
    ["git", "-C", str(parent), "rev-parse", "HEAD"], text=True
).strip()
if pin != args.parent_commit:
    raise RuntimeError(f"Expected parent {args.parent_commit}, got {pin}")


def package(spec: WorkspaceAgentSpec, root: Path) -> str:
    save_workspace_agent_package(spec, root)
    # ZIP stores local wall time; derive the epoch locally so every timezone writes midnight.
    timestamp = datetime(2000, 1, 1).timestamp()
    for path in root.rglob("*"):
        os.utime(path, (timestamp, timestamp))
    archive = pack_workspace_agent_package(root, root.with_suffix(".zip"))
    return base64.b64encode(archive.read_bytes()).decode()


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "package"
    spec = WorkspaceAgentSpec(
        id="python-reader",
        name="Python reader",
        instructions="Read safely.",
        model_provider="script",
        model="model",
        agent_provider="local",
        tools=["workspace_read_file", "workspace_list_files", "workspace_write_file", "workspace_run_command"],
        permissions=[ToolPermission(ref="workspace:read_file", scopes=["read"])],
        permission_mode="allowlist_v1",
        connectors=[ConnectorSpec(
            name="files", kind="filesystem",
            tool_refs=["workspace:read_file", "workspace:list_files", "workspace:write_file", "workspace:run_command"],
        )],
        version=WorkspaceAgentVersion(version="1.2.3"),
    )
    data = {"generated_by": "python-parent", "parent_commit": pin, "archive_base64": package(spec, root)}
    data["manifest"] = json.loads((root / "agent.json").read_text())
    for route in ["local", None]:
        configured = replace(
            spec, agent_provider=route, permission_mode="inherit",
            hosted_tools=[{"type": "web_search", "config": {"depth": "short"}}],
            extra={"fixture_option": "present"},
        )
        name = "local" if route else "model"
        data[f"{name}_options_archive"] = package(configured, Path(tmp) / name)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "workspace-agent-package.json").write_text(
        json.dumps(data, indent=2) + "\n"
    )
    print("Generated pinned Python package fixture with restricted, local-options and model-options ZIPs.")
