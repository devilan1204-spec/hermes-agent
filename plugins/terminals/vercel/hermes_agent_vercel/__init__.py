"""hermes-agent-vercel: Vercel Sandbox execution environment plugin for Hermes Agent."""

from hermes_agent_vercel.vercel_sandbox import VercelSandboxEnvironment  # noqa: F401


def register(ctx):
    """Entry point for the hermes_agent.plugins entry point group.

    Registers VercelSandboxEnvironment in the plugin capability registry
    so core code can look it up without importing from
    ``hermes_agent_vercel`` directly.
    """
    from hermes_agent_vercel.vercel_sandbox import VercelSandboxEnvironment
    ctx.register_tool_provider_entry(
        name="vercel",
        environment_classes={
            "VercelSandboxEnvironment": VercelSandboxEnvironment,
        },
    )
