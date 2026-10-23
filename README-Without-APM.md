# Evaluate flags without APM or Infrastructure Monitoring

After your flags are migrated, your services evaluate them with a Datadog SDK and the Datadog Agent. By default, this setup also sends [APM](https://docs.datadoghq.com/tracing/) traces and [Infrastructure Monitoring](https://docs.datadoghq.com/infrastructure/) data. If you only want to evaluate feature flags, you can turn both off. For installation and the migration workflow, see the [main README](README.md).

With APM turned on, you can compare error rates and latency for each flag variant during a canary rollout, and spot problems before you release to everyone. Consider that trade-off before turning it off.

---

## Contents

- [Prerequisites](#prerequisites)
- [Disable Infrastructure Monitoring on the Datadog Agent](#disable-infrastructure-monitoring-on-the-datadog-agent)
- [Disable tracing and enable Feature Flags on the service](#disable-tracing-and-enable-feature-flags-on-the-service)
- [Further reading](#further-reading)

---

## Prerequisites

- **Datadog Agent** — [Install the Agent](https://docs.datadoghq.com/agent/). Turning off Infrastructure Monitoring requires Agent version 7.77.0 or later.
- **Remote Configuration** — Flag configuration reaches your service through [Remote Configuration](https://docs.datadoghq.com/remote_configuration/). It must be enabled for your organization and for the API key the Agent uses.
- **Supported SDK** — Set up your service for [server-side Feature Flags](https://docs.datadoghq.com/feature_flags/server) with a Datadog SDK. Tracing is turned off through the [SDK's configuration](https://docs.datadoghq.com/tracing/trace_collection/library_config/), as described below.

Setup takes two configuration changes: one on the Datadog Agent and one on your service.

---

## Disable Infrastructure Monitoring on the Datadog Agent

Use the same Agent installation that you use for APM. Set the infrastructure mode to `none` with either of these options:

- Environment variable: `DD_INFRASTRUCTURE_MODE=none`
- `datadog.yaml` setting:

  ```yaml
  infrastructure_mode: none
  ```

In this mode, the Agent doesn't run infrastructure checks or send system metrics. For more information, see [Agent infrastructure modes](https://docs.datadoghq.com/agent/configuration/infrastructure-modes/).

> **Note:** Don't turn off APM on the Agent (`DD_APM_ENABLED=false`). Your service gets flag configuration through the Agent's trace port (`8126` by default). If APM is off on the Agent, that port closes and every flag evaluation returns its default value. Your service still doesn't send any traces, because tracing is turned off in the next step.

---

## Disable tracing and enable Feature Flags on the service

Set these environment variables on the service:

```bash
DD_TRACE_ENABLED=false
DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED=true
DD_ENV=<YOUR_ENVIRONMENT>
```

- `DD_TRACE_ENABLED=false` turns tracing off, so the service sends no traces. Flag evaluation keeps working, because the SDK still receives flag configuration through Remote Configuration.
- `DD_ENV` must match one of the environments set up for your flags in Datadog. If it doesn't match, flags return their default values.
- If the Agent isn't on the same host as the service, also set `DD_AGENT_HOST` to the Agent's address.

---

## Further reading

- [Server-side Feature Flags](https://docs.datadoghq.com/feature_flags/server)
- [Agent infrastructure modes](https://docs.datadoghq.com/agent/configuration/infrastructure-modes/)
- [Remote Configuration](https://docs.datadoghq.com/remote_configuration/)
