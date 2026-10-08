---
title: Create an empty staging installation without update bypasses
type: feat
date: 2026-10-08
status: proposed
---

# Create an empty staging installation without update bypasses

## Problem

The update runner assumes an installed Bot and a serving config source. Memory also binds the Bot service and its Workflow. A first Memory upload therefore fails while the Bot is absent; the normal Bot config publication refuses without an installed source. Force does not establish creation authority.

## Creation protocol

1. Keep the CLI/label update path and the production runner unchanged. Add an explicit local `staging:deploy --initialize` mode. Resolve and validate the staging profile/config before entering it. Require a clean exact source revision, local staging credentials and Docker.
2. Read complete successful native inventories from the selected staging account: Workers, Container applications, Durable Object namespaces and Workflows. Existing selected resources, unreadable lists, partial pagination or malformed rows refuse. Failed HTTP health is not absence evidence. Recheck each resource before creation.
3. Render provisional Memory from its normal template with only cross-script Bot service/Workflow bindings omitted. Create it, provision its bearer and verify its exact commit. This phase is not parity-ready. Create Resident and Sandbox only under native absence; provision their scoped credentials and verify their exact Workers. Sandbox must also pass its normal execution gate.
4. Open the plane deploy window before Bot admission. Require empty canonical legacy and consumer-owned config slots. Record/read back the normal private publication snapshot, recheck native Bot absence, and send one conditional version-zero config creation. Unknown acknowledgment stops; never replay or restore it automatically.
5. Recheck Bot absence, create it from the normal Worker template and image build, and provision its staging secrets. Use the normal post-upload application/singleton/build gate and require the exact published config version/hash plus canonical readback.
6. Restore full Memory bindings and verify the source commit again. Settle admission only after the stack passes. Keep the first-install receipt and run the broader staging scenarios separately. A partial installation is held for inspection, never adopted, deleted or reset by rerunning initialization.

## Verification

The protocol tests observe completed resource creation and refusals for installed resources, incomplete inventory, nonempty config slots, a competing Bot and an uncertain publication acknowledgment. The rendering proof preserves all normal Memory configuration except the unavailable Bot bindings. Live proof requires exact commits, canonical config, native Bot identity, sandbox execution and final full Memory bindings; upload success alone is insufficient.

## Scope

This creates a new isolated installation. It changes no production runtime, Worker template, SDK version, update preflight, ownership fence, retained workspace or release workflow. It is not a migration or recovery path for an existing installation. A single operator owns first installation.
