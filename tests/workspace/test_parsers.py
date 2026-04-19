import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from workspace.constants import BINARY_SUFFIXES, CODE_SUFFIXES, MARKDOWN_SUFFIXES, PARSEABLE_SUFFIXES


class TestParseableSuffixes:
    def test_contains_expected_extensions(self):
        assert PARSEABLE_SUFFIXES == frozenset({".pdf", ".docx", ".pptx"})

    def test_is_subset_of_binary_suffixes(self):
        assert PARSEABLE_SUFFIXES <= BINARY_SUFFIXES

    def test_no_overlap_with_code_suffixes(self):
        assert PARSEABLE_SUFFIXES & CODE_SUFFIXES == frozenset()

    def test_no_overlap_with_markdown_suffixes(self):
        assert PARSEABLE_SUFFIXES & MARKDOWN_SUFFIXES == frozenset()


from workspace.config import KnowledgebaseConfig, ParsingConfig


class TestParsingConfig:
    def test_default_values(self):
        cfg = ParsingConfig()
        assert cfg.default == "markitdown"
        assert cfg.overrides == {}

    def test_custom_default(self):
        cfg = ParsingConfig(default="pandoc")
        assert cfg.default == "pandoc"

    def test_per_extension_overrides(self):
        cfg = ParsingConfig(overrides={".docx": "pandoc"})
        assert cfg.overrides[".docx"] == "pandoc"

    def test_frozen(self):
        cfg = ParsingConfig()
        with pytest.raises(Exception):
            cfg.default = "pandoc"

    def test_nested_in_knowledgebase_config(self):
        kb = KnowledgebaseConfig()
        assert isinstance(kb.parsing, ParsingConfig)
        assert kb.parsing.default == "markitdown"

    def test_knowledgebase_config_from_raw(self):
        kb = KnowledgebaseConfig.model_validate(
            {"parsing": {"default": "pandoc", "overrides": {".docx": "pandoc"}}}
        )
        assert kb.parsing.default == "pandoc"
        assert kb.parsing.overrides == {".docx": "pandoc"}

    def test_unknown_keys_ignored(self):
        cfg = ParsingConfig.model_validate({"default": "markitdown", "future_key": True})
        assert cfg.default == "markitdown"
        assert not hasattr(cfg, "future_key")


class TestFileParserABC:
    def test_cannot_instantiate_directly(self):
        from workspace.parsers import FileParser

        with pytest.raises(TypeError):
            FileParser()

    def test_parse_returns_none_on_exception(self):
        from workspace.parsers import FileParser

        class ExplodingParser(FileParser):
            name = "exploding"

            def supported_suffixes(self) -> frozenset[str]:
                return frozenset({".boom"})

            def _convert(self, path: Path) -> str:
                raise RuntimeError("kaboom")

        parser = ExplodingParser()
        result = parser.parse(Path("/fake/file.boom"))
        assert result is None

    def test_parse_returns_none_on_empty_output(self):
        from workspace.parsers import FileParser

        class EmptyParser(FileParser):
            name = "empty"

            def supported_suffixes(self) -> frozenset[str]:
                return frozenset({".empty"})

            def _convert(self, path: Path) -> str:
                return "   \n  \n  "

        parser = EmptyParser()
        result = parser.parse(Path("/fake/file.empty"))
        assert result is None

    def test_parse_returns_content_on_success(self):
        from workspace.parsers import FileParser

        class GoodParser(FileParser):
            name = "good"

            def supported_suffixes(self) -> frozenset[str]:
                return frozenset({".good"})

            def _convert(self, path: Path) -> str:
                return "# Converted\n\nContent."

        parser = GoodParser()
        result = parser.parse(Path("/fake/file.good"))
        assert result == "# Converted\n\nContent."


@pytest.fixture
def mock_markitdown():
    """Mock the markitdown module regardless of whether it's installed."""
    mock_result = MagicMock()
    mock_result.markdown = "# Converted\n\nParsed content from document."
    mock_instance = MagicMock()
    mock_instance.convert.return_value = mock_result
    mock_class = MagicMock(return_value=mock_instance)

    module = types.ModuleType("markitdown")
    module.MarkItDown = mock_class

    with patch.dict(sys.modules, {"markitdown": module}):
        yield mock_instance


class TestMarkitdownParser:
    def test_name(self):
        from workspace.parsers import MarkitdownParser

        assert MarkitdownParser.name == "markitdown"

    def test_supported_suffixes(self):
        from workspace.parsers import MarkitdownParser

        suffixes = MarkitdownParser().supported_suffixes()
        assert ".pdf" in suffixes
        assert ".docx" in suffixes
        assert ".pptx" in suffixes

    def test_parse_calls_markitdown_convert(self, tmp_path, mock_markitdown):
        from workspace.parsers import MarkitdownParser

        pdf = tmp_path / "report.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake content")

        parser = MarkitdownParser()
        result = parser.parse(pdf)

        assert result == "# Converted\n\nParsed content from document."
        mock_markitdown.convert.assert_called_once_with(str(pdf))

    def test_parse_returns_none_when_markitdown_not_installed(self, tmp_path):
        from workspace.parsers import MarkitdownParser

        pdf = tmp_path / "report.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")

        with patch.dict(sys.modules, {"markitdown": None}):
            parser = MarkitdownParser()
            result = parser.parse(pdf)

        assert result is None
