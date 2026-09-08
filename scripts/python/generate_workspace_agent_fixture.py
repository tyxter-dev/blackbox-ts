"""Generate Python ZIP fixtures with the pinned parent src on PYTHONPATH.

From the TypeScript repository root:
PYTHONPATH=/path/to/blackbox/src python3 scripts/python/generate_workspace_agent_fixture.py
pnpm exec prettier --write tests/fixtures/python/workspace-agent-package.json
"""

import base64
import json
import os
import subprocess
import tempfile
from dataclasses import replace
from pathlib import Path

import blackbox
from blackbox.workspace_agents.package import (
    pack_workspace_agent_package,
    save_workspace_agent_package,
)
from blackbox.workspace_agents.permissions import ConnectorSpec, ToolPermission
from blackbox.workspace_agents.spec import WorkspaceAgentSpec, WorkspaceAgentVersion

PIN = "d5be68e03ca7750920569578710a2ee25d25530c"
parent = Path(blackbox.__file__).resolve().parents[2]
pin = subprocess.check_output(
    ["git", "-C", str(parent), "rev-parse", "HEAD"], text=True
).strip()
if pin != PIN:
    raise RuntimeError(f"Expected parent {PIN}, got {pin}")


def package(spec: WorkspaceAgentSpec, root: Path) -> str:
    save_workspace_agent_package(spec, root)
    # Python's real writer uses file mtimes; freeze them for reproducible ZIP bytes.
    for path in root.rglob("*"):
        os.utime(path, (946684800, 946684800))
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
    data = {"parent_commit": pin, "archive_base64": package(spec, root)}
    data["manifest"] = json.loads((root / "agent.json").read_text())
    for route in ["local", None]:
        configured = replace(
            spec, agent_provider=route, permission_mode="inherit",
            hosted_tools=[{"type": "web_search", "config": {"depth": "short"}}],
            extra={"fixture_option": "present"},
        )
        name = "local" if route else "model"
        data[f"{name}_options_archive"] = package(configured, Path(tmp) / name)
    Path("tests/fixtures/python/workspace-agent-package.json").write_text(
        json.dumps(data, indent=2) + "\n"
    )
    print("Generated pinned Python package fixture with restricted, local-options and model-options ZIPs.")
