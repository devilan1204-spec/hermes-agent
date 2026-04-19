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
