# Set Up Agent-Based Feature Flags Without APM Tracing or Infrastructure Monitoring

For installation and the migration workflow, see the [main README](README.md).

---

## Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [Disable Infrastructure Monitoring on the Datadog Agent](#disable-infrastructure-monitoring-on-the-datadog-agent)
  - [Disable tracing and enable feature flags on the service](#disable-tracing-and-enable-feature-flags-on-the-service)
- [Verify the setup](#verify-the-setup)
- [Further reading](#further-reading)

---

## Overview

Server-side Feature Flags can be deployed using the Datadog SDK and the Datadog Agent. By default, this setup also sends [APM](https://docs.datadoghq.com/tracing/) traces and [Infrastructure Monitoring](https://docs.datadoghq.com/infrastructure/) data. To only evaluate feature flags, turn both off.

With APM tracing turned on, you can compare error rates and latency for each flag variant during a canary rollout, which helps you spot problems before a full release.

This guide explains how to disable APM tracing and Infrastructure Monitoring.

---

## Prerequisites

- **Datadog Agent**: [Install the Agent](https://docs.datadoghq.com/agent/). Turning off Infrastructure Monitoring requires Agent version 7.77.0 or later.
- **Remote Configuration**: Flag configuration reaches your service through [Remote Configuration](https://docs.datadoghq.com/remote_configuration/). It must be enabled for your organization and for the API key the Agent uses.
- **Supported SDK**: Set up your service for [server-side Feature Flags](https://docs.datadoghq.com/feature_flags/server/). Tracing is turned off through the [Datadog SDK configuration](https://docs.datadoghq.com/tracing/trace_collection/library_config/), as described in the following steps.

---

## Setup

Setup takes two configuration changes: one on the Datadog Agent and one on your service.

### Disable Infrastructure Monitoring on the Datadog Agent

Use the same Agent installation that you use for APM. Set the infrastructure mode to `none` with either of these options:

- Environment variable: `DD_INFRASTRUCTURE_MODE=none`
- `datadog.yaml` setting: `infrastructure_mode: none`

In this mode, the Agent doesn't run infrastructure checks or send system metrics. For more information, see [Agent infrastructure modes](https://docs.datadoghq.com/agent/configuration/infrastructure-modes/).

> [!WARNING]
> Don't turn off APM on the Agent (`DD_APM_ENABLED=false`). Your service gets flag configuration through the Agent's trace port (`8126` by default). If APM is off on the Agent, that port closes and every flag evaluation returns its default value. Your service doesn't send any traces, because you turn off tracing in the following section.

### Disable tracing and enable feature flags on the service

Set these environment variables on the service:

```bash
DD_TRACE_ENABLED=false
DD_FEATURE_FLAGS_CONFIGURATION_SOURCE=remote_config
DD_ENV=<YOUR_ENVIRONMENT>

# Required only if the Agent runs on a different host than the service
DD_AGENT_HOST=<AGENT_ADDRESS>
```

- `DD_TRACE_ENABLED=false` turns tracing off, so the service sends no traces. The SDK still receives flag configuration through Remote Configuration, so flag evaluation keeps working.
- `DD_FEATURE_FLAGS_CONFIGURATION_SOURCE=remote_config` tells the SDK to get flag configuration from the Agent. Without it, supported SDKs default to agentless delivery, which doesn't use the Agent.
- `DD_ENV` must match one of the environments set up for your flags in Datadog. If it doesn't match, flags return their default values.

> [!NOTE]
> PHP, and SDK versions earlier than Java 1.66.0, Node.js 6.12.0, Python 4.14.0, .NET 3.54.0, Go 2.11.0, and Ruby 2.44.0, don't support `DD_FEATURE_FLAGS_CONFIGURATION_SOURCE`. For these SDKs, set `DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED=true` instead. For more information, see [Migrate an existing Remote Configuration setup](https://docs.datadoghq.com/feature_flags/concepts/configuration_sources/#migrate-an-existing-remote-configuration-setup).

---

## Verify the setup

After you restart the Agent and the service, confirm the following:

- **Flags evaluate as expected**: Evaluate a flag that has a non-default variant targeted to the service's environment. The service returns the targeted variant, not the default value.
- **The service sends no traces**: In the [Trace Explorer](https://app.datadoghq.com/apm/traces) Live Search view, filter by the service name and environment. No new spans appear for the service.
- **The Agent sends no infrastructure metrics**: In the [Infrastructure List](https://app.datadoghq.com/infrastructure/hosts), the host doesn't report system metrics such as CPU or memory.

If every flag returns its default value, confirm that APM is enabled on the Agent, that `DD_ENV` matches a flag environment, and that the service can reach the Agent on port `8126`.

---

## Further reading

- [Server-Side Feature Flags](https://docs.datadoghq.com/feature_flags/server/)
- [Agent Infrastructure Modes](https://docs.datadoghq.com/agent/configuration/infrastructure-modes/)
- [Remote Configuration](https://docs.datadoghq.com/remote_configuration/)
