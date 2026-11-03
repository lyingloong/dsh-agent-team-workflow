# agent-team-workflow development rules

## No backward compatibility during development

This repository is pre-1.0. When an architecture change lands, replace the old
schema, engine, persisted state, tools and panel outright.

Do not add v1 compatibility layers, migrations, aliases, dual code paths, or
"keep both" switches. Delete the replaced implementation and its tests. The
maintainer explicitly chose this on 2026-11-04: development velocity and a clean
model matter more than preserving the old stage-based format.

## Permissions for workflow nodes

A workflow node may request host capabilities such as executing a command or
making an HTTP request.

- The session must ask the user before granting full node permissions.
- The default is deny.
- If the user does not grant full access, the session defines a restricted
  workflow: an allowlist of commands/hosts, or no privileged nodes at all.
- The runtime enforces the grant; a definition cannot silently widen it.

## Architecture direction

Workflows are node graphs: nodes have types and input/output contracts, edges
carry outcomes/conditions, and artifacts flow between nodes. The engine is the
control plane (scheduling, leases, retries, permissions); node executors are the
execution plane (agent, command, HTTP, human, fan-out/join, sub-workflow).
