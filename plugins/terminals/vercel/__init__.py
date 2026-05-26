"""Bridge module — delegates plugin registration to hermes_agent_vercel."""


def register(ctx):
    """Plugin entry point — delegates to the inner hermes_agent_vercel package."""
    from hermes_agent_vercel import register as _inner_register
    _inner_register(ctx)
