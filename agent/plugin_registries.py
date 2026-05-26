"""Plugin capability registries.

Each plugin's ``register(ctx)`` function populates these registries via
``ctx.register_<capability>()``.  The core codebase then queries the
registries instead of importing from plugin packages directly.

This is the **only** coupling point between the core and plugins: the core
imports from ``agent.plugin_registries``, never from ``hermes_agent_*``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import (
    Any,
    Callable,
    Dict,
    List,
    Optional,
    Protocol,
    Sequence,
    Type,
    runtime_checkable,
)


# ---------------------------------------------------------------------------
# Auth providers
# ---------------------------------------------------------------------------

@runtime_checkable
class AuthProvider(Protocol):
    """A plugin that can provide or check authentication credentials.

    Registered via ``ctx.register_auth_provider(name, provider)``.
    Queried by ``hermes_cli/auth_commands.py``, ``doctor.py``, etc.
    """

    @property
    def name(self) -> str: ...

    def has_credentials(self) -> bool:
        """Return True if the required credentials are present in env/config."""
        ...

    def check_env_vars(self) -> Dict[str, str | None]:
        """Return a dict of env-var-name → current-value (or None if unset).

        Used by ``hermes doctor`` to display credential status.
        """
        ...

    def resolve_token(self, **kwargs: Any) -> Any:
        """Resolve and return an auth token/credential for the provider.

        The return type is provider-specific (string, tuple, object, etc.).
        """
        ...

    def refresh_token(self, **kwargs: Any) -> Any:
        """Refresh an existing token.  Raises if refresh is not supported."""
        ...


@dataclass
class AuthProviderEntry:
    provider: AuthProvider
    """The auth provider instance."""

    cli_group: str = ""
    """CLI argument group name (e.g. 'Anthropic', 'AWS / Bedrock')."""

    setup_subcommands: bool = False
    """Whether this provider adds CLI auth subcommands (login, logout, etc.)."""


# ---------------------------------------------------------------------------
# Transport builders
# ---------------------------------------------------------------------------

@runtime_checkable
class TransportBuilder(Protocol):
    """A plugin that builds clients and converts messages for a model transport.

    Registered via ``ctx.register_transport(name, builder)``.
    Queried by ``agent/transports/`` and ``agent/auxiliary_client.py``.
    """

    def build_client(self, **kwargs: Any) -> Any:
        """Build and return a provider-specific API client."""
        ...

    def build_kwargs(self, **kwargs: Any) -> Dict[str, Any]:
        """Build the kwargs dict for a provider-specific API call."""
        ...

    def convert_messages(self, messages: Sequence[Any], **kwargs: Any) -> Any:
        """Convert internal message format to provider-specific format."""
        ...

    def convert_tools(self, tools: Sequence[Any], **kwargs: Any) -> Any:
        """Convert internal tool format to provider-specific format."""
        ...

    def normalize_response(self, response: Any, **kwargs: Any) -> Any:
        """Normalize a provider-specific response into the internal format."""
        ...


# ---------------------------------------------------------------------------
# Platform adapters
# ---------------------------------------------------------------------------

@dataclass
class PlatformAdapterEntry:
    """A registered platform adapter.

    Registered via ``ctx.register_platform(name, entry)``.
    Queried by ``gateway/run.py`` and ``tools/send_message_tool.py``.
    """
    name: str
    """Platform identifier (e.g. 'telegram', 'slack')."""

    adapter_class: Type
    """The adapter class (e.g. TelegramAdapter)."""

    check_requirements: Callable[[], bool]
    """Check if the platform's dependencies are installed and configured."""

    available_flag: str = ""
    """Name of the module-level AVAILABLE boolean, if any."""

    constants: Dict[str, Any] = field(default_factory=dict)
    """Platform-specific constants (e.g. FEISHU_DOMAIN, LARK_DOMAIN)."""

    helper_functions: Dict[str, Callable] = field(default_factory=dict)
    """Platform-specific helper functions (e.g. probe_bot, qr_register)."""


# ---------------------------------------------------------------------------
# Tool providers
# ---------------------------------------------------------------------------

@dataclass
class ToolProviderEntry:
    """A registered tool provider.

    Registered via ``ctx.register_tool_provider(name, entry)``.
    Queried by ``tools/`` modules.
    """
    name: str
    """Tool identifier (e.g. 'tts', 'stt', 'fal', 'daytona')."""

    tool_functions: Dict[str, Callable] = field(default_factory=dict)
    """Tool functions keyed by name (e.g. 'text_to_speech_tool', 'transcribe_audio')."""

    check_fn: Optional[Callable] = None
    """Check if the tool's dependencies are available."""

    constants: Dict[str, Any] = field(default_factory=dict)
    """Tool-specific constants (e.g. MAX_FILE_SIZE)."""

    config_functions: Dict[str, Callable] = field(default_factory=dict)
    """Config/utility functions (e.g. _get_provider, _load_stt_config)."""

    environment_classes: Dict[str, Type] = field(default_factory=dict)
    """Environment classes for terminal backends (e.g. DaytonaEnvironment)."""


# ---------------------------------------------------------------------------
# Model metadata providers
# ---------------------------------------------------------------------------

@dataclass
class ModelMetadataEntry:
    """A registered model metadata provider.

    Registered via ``ctx.register_model_metadata(name, entry)``.
    Queried by ``agent/model_metadata.py`` and CLI model commands.
    """
    name: str
    """Provider identifier (e.g. 'anthropic', 'bedrock')."""

    get_context_length: Optional[Callable[[str], int | None]] = None
    """Return the context length for a model name, or None if unknown."""

    list_models: Optional[Callable[[], List[str]]] = None
    """Return a list of known model IDs for this provider."""

    constants: Dict[str, Any] = field(default_factory=dict)
    """Provider-specific constants (e.g. _COMMON_BETAS, betas lists)."""


# ---------------------------------------------------------------------------
# Credential pool entries
# ---------------------------------------------------------------------------

@dataclass
class CredentialPoolEntry:
    """A registered credential pool provider.

    Registered via ``ctx.register_credential_pool(name, entry)``.
    Queried by ``agent/credential_pool.py``.
    """
    name: str
    """Provider identifier (e.g. 'anthropic')."""

    read_credentials: Optional[Callable] = None
    """Read stored credentials."""

    write_credentials: Optional[Callable] = None
    """Write/store credentials."""

    refresh_credentials: Optional[Callable] = None
    """Refresh stored credentials."""

    read_oauth: Optional[Callable] = None
    """Read OAuth credentials."""


# ---------------------------------------------------------------------------
# The global registries (singleton)
# ---------------------------------------------------------------------------

class PluginRegistries:
    """Central store for all plugin-registered capabilities.

    A single instance is created at import time and shared across the
    process.  Plugins populate it during ``register()``; the core
    queries it at runtime.
    """

    def __init__(self) -> None:
        self.auth_providers: Dict[str, AuthProviderEntry] = {}
        self.transport_builders: Dict[str, TransportBuilder] = {}
        self.platform_adapters: Dict[str, PlatformAdapterEntry] = {}
        self.tool_providers: Dict[str, ToolProviderEntry] = {}
        self.model_metadata: Dict[str, ModelMetadataEntry] = {}
        self.credential_pools: Dict[str, CredentialPoolEntry] = {}
        self._provider_services: Dict[str, Dict[str, Any]] = {}

    # -- registration methods (called from PluginContext) --------------------

    def register_auth_provider(
        self,
        name: str,
        provider: AuthProvider,
        *,
        cli_group: str = "",
        setup_subcommands: bool = False,
    ) -> None:
        self.auth_providers[name] = AuthProviderEntry(
            provider=provider,
            cli_group=cli_group,
            setup_subcommands=setup_subcommands,
        )

    def register_transport(self, name: str, builder: TransportBuilder) -> None:
        self.transport_builders[name] = builder

    def register_platform(self, entry: PlatformAdapterEntry) -> None:
        self.platform_adapters[entry.name] = entry

    def register_tool_provider(self, entry: ToolProviderEntry) -> None:
        self.tool_providers[entry.name] = entry

    def register_model_metadata(self, entry: ModelMetadataEntry) -> None:
        self.model_metadata[entry.name] = entry

    def register_credential_pool(self, entry: CredentialPoolEntry) -> None:
        self.credential_pools[entry.name] = entry

    # -- query helpers -------------------------------------------------------

    def get_auth_provider(self, name: str) -> AuthProviderEntry | None:
        return self.auth_providers.get(name)

    def get_transport(self, name: str) -> TransportBuilder | None:
        return self.transport_builders.get(name)

    def get_platform(self, name: str) -> PlatformAdapterEntry | None:
        return self.platform_adapters.get(name)

    def get_tool_provider(self, name: str) -> ToolProviderEntry | None:
        return self.tool_providers.get(name)

    def get_model_metadata(self, name: str) -> ModelMetadataEntry | None:
        return self.model_metadata.get(name)

    def get_credential_pool(self, name: str) -> CredentialPoolEntry | None:
        return self.credential_pools.get(name)

    def all_auth_providers(self) -> List[AuthProviderEntry]:
        return list(self.auth_providers.values())

    def all_platforms(self) -> List[PlatformAdapterEntry]:
        return list(self.platform_adapters.values())

    def all_tool_providers(self) -> List[ToolProviderEntry]:
        return list(self.tool_providers.values())

    # -- provider services (model-provider namespace) -----------------------

    def register_provider_services(self, name: str, services: Dict[str, Any]) -> None:
        """Register a namespace dict of provider-specific services.

        This is the escape hatch for model-provider plugins that expose many
        symbols (anthropic has 50+).  Each plugin registers its public surface
        as a flat dict of ``{symbol_name: callable_or_value}``.  Core code
        looks up specific symbols instead of importing from the plugin
        package directly.

        Each callable value is stored as a *lazy module-attribute reference*
        so that ``unittest.mock.patch("pkg.mod.fn")`` works correctly in
        tests — the registry re-reads ``mod.fn`` on every lookup instead of
        capturing the function object at register time.

        Example::

            registries.register_provider_services("anthropic", {
                "build_anthropic_client": build_anthropic_client,
                "resolve_anthropic_token": resolve_anthropic_token,
                "_is_oauth_token": _is_oauth_token,
                ...
            })
        """
        import sys

        def _make_lazy(fn: Any) -> Any:
            """Return a lazy wrapper that re-reads fn from its module each call.

            This makes mock.patch() on the module attribute work transparently —
            the registry never caches the function object, just the reference path.
            """
            if not callable(fn):
                return fn
            module = getattr(fn, "__module__", None)
            qualname = getattr(fn, "__qualname__", None)
            if not module or not qualname or "." in qualname:
                # non-simple attribute (lambda, nested fn, class method) — store directly
                return fn

            class _LazyRef:
                __slots__ = ("_mod", "_attr", "_fallback")

                def __init__(self, mod: str, attr: str, fallback: Any) -> None:
                    self._mod = mod
                    self._attr = attr
                    self._fallback = fallback

                def __call__(self, *args: Any, **kwargs: Any) -> Any:
                    mod = sys.modules.get(self._mod)
                    live = getattr(mod, self._attr, self._fallback) if mod else self._fallback
                    return live(*args, **kwargs)

                def __repr__(self) -> str:  # pragma: no cover
                    return f"<LazyRef {self._mod}.{self._attr}>"

                # Allow isinstance checks and hasattr to pass through
                def __bool__(self) -> bool:
                    return True

            return _LazyRef(module, qualname, fn)

        self._provider_services[name] = {k: _make_lazy(v) for k, v in services.items()}

    def get_provider_service(self, provider: str, name: str) -> Any:
        """Look up a single symbol from a provider's service namespace.

        Returns ``None`` if the provider is not registered or the symbol
        doesn't exist.
        """
        ns = self._provider_services.get(provider)
        if ns is None:
            return None
        return ns.get(name)

    def get_provider_namespace(self, provider: str) -> Dict[str, Any]:
        """Return the full service namespace dict for a provider (empty dict if unregistered)."""
        return self._provider_services.get(provider, {})


# Module-level singleton — the one and only instance.
registries = PluginRegistries()
