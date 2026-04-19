"""File parsers -- convert binary formats (.pdf, .docx, .pptx) to markdown.

FileParser ABC defines the contract. Built-in backends: markitdown, pandoc.
CompositeParser routes extensions to the configured backend.
"""

import logging
import subprocess
from abc import ABC, abstractmethod
from pathlib import Path
from typing import ClassVar

log = logging.getLogger(__name__)


class FileParser(ABC):
    name: ClassVar[str]

    @abstractmethod
    def supported_suffixes(self) -> frozenset[str]: ...

    @abstractmethod
    def _convert(self, path: Path) -> str: ...

    def parse(self, path: Path) -> str | None:
        try:
            result = self._convert(path)
            return result if result and result.strip() else None
        except Exception as exc:
            log.warning("Parser %s failed on %s: %s", self.name, path, exc)
            return None


class MarkitdownParser(FileParser):
    name = "markitdown"

    def supported_suffixes(self) -> frozenset[str]:
        return frozenset({".pdf", ".docx", ".pptx"})

    def _convert(self, path: Path) -> str:
        from markitdown import MarkItDown

        md = MarkItDown()
        result = md.convert(str(path))
        return result.markdown


class PandocParser(FileParser):
    name = "pandoc"

    def supported_suffixes(self) -> frozenset[str]:
        return frozenset({".pdf", ".docx", ".pptx"})

    def _convert(self, path: Path) -> str:
        result = subprocess.run(
            ["pandoc", str(path), "-t", "markdown"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        result.check_returncode()
        return result.stdout
