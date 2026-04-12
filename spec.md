# Python Module Taste Guide

_Opinionated notes on structuring Python projects where many people (and agents) contribute. Not a style guide — a taste document._

---

## 1. The file is the unit of understanding

Every `.py` file should be explainable in one sentence. If you can't say "this file handles X" without using the word "and", split it.

```
# Good: one sentence each
backends/docker.py      → "Docker execution backend"
backends/ssh.py         → "SSH execution backend"
agent/planner.py        → "Step planning and decomposition"
agent/executor.py       → "Tool dispatch and result collection"

# Bad: needs "and"
agent/core.py           → "Planning and execution and tool dispatch and error handling"
utils/helpers.py        → "Retry logic and string formatting and path resolution"
```

A 400-line file with one clear purpose is better than four 100-line files with fuzzy purposes.

---

## 2. Directory = namespace = concept boundary

A directory exists to group files that share a concept AND need to import each other. If the files don't need each other, they don't need a directory — they can be siblings.

```
# This directory earns its existence:
backends/
├── __init__.py     # re-exports Backend, DockerBackend, etc.
├── base.py         # Protocol/ABC
├── docker.py       # imports base
├── ssh.py          # imports base
└── local.py        # imports base

# This directory shouldn't exist:
utils/
├── __init__.py
├── retry.py        # used by backends
├── formatting.py   # used by cli
└── paths.py        # used by config
# These have nothing to do with each other. Just put them where they're used.
```

**Test:** if you delete the `__init__.py` and the directory, would each file work as a top-level module? If yes, the directory is probably just cosmetic grouping, not a real namespace.

---

## 3. Flat until it hurts (the two-level rule)

Start with at most two levels of nesting under `src/`. Add a third level only when a directory has 7+ files AND they cluster into obvious sub-groups.

```
# Good: two levels
src/hermes_agent/
├── backends/
├── agent/
├── tools/
├── config/
└── cli/

# Premature: three levels when you only have 2 files
src/hermes_agent/
└── backends/
    └── docker/
        ├── __init__.py
        ├── container.py    # only 80 lines
        └── image.py        # only 60 lines
        # Just keep this as backends/docker.py until it's 300+ lines
```

Depth costs cognitive overhead. Every nested directory is a question: "do I look in `docker/` or `docker/container/`?" Flat trees answer questions faster.

---

## 4. `__init__.py` is your public API

Treat `__init__.py` as the **only** file external consumers should import from. Everything else is internal.

```python
# backends/__init__.py
from .base import Backend, ExecResult
from .docker import DockerBackend
from .local import LocalBackend
from .ssh import SSHBackend

__all__ = ["Backend", "ExecResult", "DockerBackend", "LocalBackend", "SSHBackend"]
```

This gives you freedom to refactor internals. You can split `docker.py` into `docker_container.py` + `docker_network.py` without changing any external imports — because everyone imports from `backends`, not from `backends.docker`.

**Rule:** if you see `from hermes_agent.backends.docker import DockerBackend` in the agent code, that's a smell. It should be `from hermes_agent.backends import DockerBackend`.

---

## 5. Dependency arrows flow one way

Draw the import graph. It should be a DAG with clear layers:

```
cli
 ↓
agent
 ↓  ↘
tools  backends
 ↓       ↓
config  config
```

**Hard rules:**

- `config` imports nothing from the project (it's the leaf)
- `backends` never imports from `agent`
- `tools` never imports from `agent`
- `agent` imports from `tools` and `backends`
- `cli` imports from `agent` (and maybe `config`)

If you're tempted to create a circular import, you're missing an interface. Extract the shared type into `config` or a `types.py` at the appropriate level.

```python
# Bad: circular
# agent/executor.py imports backends.docker
# backends/docker.py imports agent.state  ← circular!

# Fix: extract the shared type
# types.py (or config/types.py)
@dataclass
class AgentState:
    ...

# Now both agent and backends can import from types
```

---

## 6. One file owns each type

Every important class/dataclass/Protocol should live in exactly one file, and that file should be obvious from the type name.

```
BackendConfig      → config/backends.py   (or config.py if config is flat)
DockerBackend      → backends/docker.py
AgentLoop          → agent/loop.py
ToolRegistry       → tools/registry.py
```

Anti-pattern: putting `BackendConfig` in `backends/base.py` because "it's related to backends." No — config lives in config. Backends _use_ config, they don't _define_ config. This keeps the dependency arrows clean.

---

## 7. Protocols over ABCs for external contracts

Use `typing.Protocol` when you want to define "what shape does this thing have" without forcing inheritance. Use ABCs when you want to share implementation.

```python
# Protocol: structural subtyping, no inheritance needed
# Good for: interfaces consumed by other packages
@runtime_checkable
class Backend(Protocol):
    async def execute(self, cmd: str) -> ExecResult: ...
    async def upload(self, local: Path, remote: str) -> None: ...

# ABC: nominal subtyping, shared implementation
# Good for: when backends share 50+ lines of common logic
class BaseBackend(ABC):
    def __init__(self, config: BackendConfig):
        self.config = config
        self._setup_logging()  # shared

    @abstractmethod
    async def execute(self, cmd: str) -> ExecResult: ...

    def _setup_logging(self):  # shared implementation
        ...
```

**Default to Protocol.** Reach for ABC only when you have real shared code, not just shared signatures.

---

## 8. Config is typed, loaded once, passed explicitly

```python
# config.py
from pydantic import BaseModel

class BackendConfig(BaseModel):
    type: str = "local"
    docker_image: str | None = None
    ssh_host: str | None = None
    timeout: float = 30.0

class AgentConfig(BaseModel):
    model: str = "gpt-4o"
    max_steps: int = 50
    backend: BackendConfig = BackendConfig()

# Loading happens once, at the edge
def load_config(path: Path) -> AgentConfig:
    raw = yaml.safe_load(path.read_text())
    return AgentConfig(**raw)
```

**Rules:**

- Config classes import nothing from the project
- Config is loaded in `cli/` or `main()`, never inside library code
- No module-level globals like `CONFIG = load_config()`. Pass it through constructors.
- No `os.environ.get()` scattered through library code. Read env vars in config loading only.

---

## 9. The "where does new code go?" test

Before committing to a structure, simulate these scenarios:

| Scenario                                 | Should be obvious where to add it                       |
| ---------------------------------------- | ------------------------------------------------------- |
| New execution backend (e.g., Kubernetes) | `backends/kubernetes.py` + register in `__init__.py`    |
| New CLI subcommand                       | `cli/new_command.py` or a function in existing cli file |
| New tool for the agent                   | `tools/new_tool.py` + register in tool registry         |
| New config option                        | Add field to existing config model in `config.py`       |
| Bug fix in SSH execution                 | `backends/ssh.py`, nowhere else                         |
| New eval benchmark                       | `eval/new_benchmark.py`                                 |

If any of these require touching 5+ files or the answer is "I'm not sure," the structure needs work.

---

## 10. Files that earn their existence

Every file in the project should pass one of these tests:

1. **It's the single home for a concept** (e.g., `docker.py` owns DockerBackend)
2. **It's a boundary** (e.g., `__init__.py` defines the public API)
3. **It's an entrypoint** (e.g., `__main__.py`, CLI commands)
4. **It's config/constants** (e.g., `config.py`, `defaults.py`)

Files that don't pass: `helpers.py`, `misc.py`, `common.py`, `base.py` (when it has no ABC/Protocol), `types.py` (when it has 2 types that belong in their respective modules).

---

## 11. Naming that communicates

**Files:** noun or noun_phrase, lowercase_snake. The name should tell you what's _in_ the file, not what it _does_.

```
# Good: tells you what's inside
registry.py         # contains ToolRegistry
docker.py           # contains DockerBackend
planner.py          # contains Planner, PlanStep

# Bad: tells you what it does (vague)
run.py              # run what?
process.py          # process what?
handle.py           # handle what?
```

**Directories:** plural nouns for collections, singular for a single concern.

```
backends/           # plural: collection of backend implementations
config/             # singular: one concern
tools/              # plural: collection of tools
agent/              # singular: one agent system
```

---

## 12. Tests: organize by confidence, not by source

```
tests/
├── unit/              # fast, isolated, mock everything external
│   ├── test_planner.py
│   └── test_config.py
├── integration/       # real backends, real I/O, but controlled
│   ├── test_docker_backend.py
│   └── test_ssh_backend.py
├── e2e/               # full agent runs, slow, CI-only
│   ├── test_ctf_solve.py
│   └── test_migration.py
└── fixtures/          # shared test data
    ├── sample_config.yaml
    └── mock_responses/
```

Don't mirror `src/` 1:1. Test files group by _what you're verifying_, not which source file they exercise. `test_agent_can_recover_from_backend_failure.py` might touch `agent/`, `backends/`, and `config/` — and that's fine.

---

## 13. The import order tells a story

Within a file, imports should read top-down as: stdlib → third-party → project internals, with project internals going from "far away" to "nearby."

```python
# stdlib
import asyncio
from pathlib import Path

# third-party
from pydantic import BaseModel

# project: far away (config is a leaf, used everywhere)
from hermes_agent.config import BackendConfig

# project: nearby (same package)
from .base import Backend, ExecResult
```

This isn't just aesthetics — it makes dependency direction visible at a glance.

---

## 14. When to split a file

Split when ANY of these are true:

- File exceeds ~400 lines AND has 2+ distinct responsibilities
- Two people frequently have merge conflicts in the same file
- You find yourself adding `# --- Section: X ---` comments to navigate
- The file has internal classes/functions that another module wants to import

Do NOT split just because:

- The file is "long" (a 600-line file with one clear purpose is fine)
- You "might need to" someday
- A linter told you to

---

## 15. Module-level code is a liability

Every line that runs at import time is a line that can break `import hermes_agent`.

```python
# Bad: runs at import time
import docker
client = docker.from_env()  # crashes if Docker isn't running

# Good: lazy, runs when needed
def get_docker_client():
    import docker
    return docker.from_env()

# Also good: runs in __init__, not at module level
class DockerBackend:
    def __init__(self, config: BackendConfig):
        import docker
        self._client = docker.from_env()
```

**Rule:** module-level code should only be: imports, type definitions, constants, and function/class definitions. Never side effects.

---

## Reading list

These are worth reading not for rules but for _calibrating your taste_:

- **Hynek Schlawack — [Testing & Packaging](https://hynek.me/articles/testing-packaging/)**: Best single article on src layout and why it matters.
- **Python Packaging Guide — [src layout vs flat layout](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/)**: The official take.
- **Brandon Rhodes — [The Clean Architecture in Python](https://rhodesmill.org/brandon/talks/#clean-architecture-python)** (PyCon talk): Good for understanding dependency direction without going full enterprise.
- **Cosmicpython — [Architecture Patterns with Python](https://www.cosmicpython.com/)**: Free online book. Chapters 1-4 on repository pattern and dependency inversion are relevant; skip the CQRS/event-sourcing stuff unless you need it.
- **Hatch documentation**: Modern Python project management. Reading how Hatch structures things will passively teach you good layout conventions.
- **Any well-structured open source project**: `httpx`, `pydantic`, `ruff` (Rust but the Python wrapper layout is instructive), `textual`. Read their `src/` trees and `__init__.py` files.

---

_The goal is not elegance. The goal is that a new contributor — human or agent — can go from "I need to change X" to "I know which file to open" in under 10 seconds._
