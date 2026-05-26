"""hermes-agent-azure: Microsoft Entra ID / Azure Identity adapter for Hermes Agent."""

from hermes_agent_azure.adapter import (  # noqa: F401
    SCOPE_AI_AZURE_DEFAULT,
    EntraIdentityConfig,
    _build_default_credential,
    _require_azure_identity,
    build_bearer_http_client,
    build_credential,
    build_token_provider,
    describe_active_credential,
    has_azure_identity_credentials,
    has_azure_identity_installed,
    is_token_provider,
    materialize_bearer_for_http,
    reset_credential_cache,
)


def register(ctx):
    """Entry point for the hermes_agent.plugins entry point group."""
    from hermes_agent_azure import adapter

    ctx.register_provider_services("azure", {
        # Auth / credentials
        "is_token_provider": adapter.is_token_provider,
        "has_azure_identity_credentials": adapter.has_azure_identity_credentials,
        "has_azure_identity_installed": adapter.has_azure_identity_installed,
        # Client building
        "build_bearer_http_client": adapter.build_bearer_http_client,
        "build_credential": adapter.build_credential,
        "build_token_provider": adapter.build_token_provider,
        "materialize_bearer_for_http": adapter.materialize_bearer_for_http,
        "reset_credential_cache": adapter.reset_credential_cache,
        # Constants / config
        "SCOPE_AI_AZURE_DEFAULT": adapter.SCOPE_AI_AZURE_DEFAULT,
        "EntraIdentityConfig": adapter.EntraIdentityConfig,
        # Internal helpers
        "_build_default_credential": adapter._build_default_credential,
        "_require_azure_identity": adapter._require_azure_identity,
        "describe_active_credential": adapter.describe_active_credential,
    })
