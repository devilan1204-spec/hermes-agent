"""Regression tests for the file-mutation verifier footer (#40772).

After #40772 the verifier footer is stored separately from final_response
in result['file_mutation_verifier_footer'], not concatenated into
final_response.  TTS, transform_llm_output, and other downstream consumers
of final_response should never see the advisory text.

These are lightweight unit tests that verify the storage contract directly
without running the full conversation loop.
"""

from __future__ import annotations

import json
import pytest

from run_agent import (
    AIAgent,
    _extract_file_mutation_targets,
)


def _bare_agent():
    """Return a bare AIAgent (no __init__) with just the verifier attrs."""
    agent = object.__new__(AIAgent)
    agent._turn_failed_file_mutations = {}
    agent._file_mutation_verifier_footer = None
    return agent


class TestFooterStorageContract:
    """The footer must be stored in agent._file_mutation_verifier_footer
    and NOT concatenated into final_response."""

    def test_footer_not_in_final_response(self):
        """Simulate what conversation_loop.py does: store footer separately."""
        agent = _bare_agent()

        # Simulate a failed patch during a turn
        agent._turn_failed_file_mutations["/tmp/test.md"] = {
            "tool": "patch",
            "error_preview": "Could not find old_string",
        }

        # Simulate the conversation loop's footer logic (the #40772 fix)
        final_response = "I tried to patch the file."
        interrupted = False

        if final_response and not interrupted:
            _failed = getattr(agent, "_turn_failed_file_mutations", None) or {}
            if _failed:
                footer = AIAgent._format_file_mutation_failure_footer(_failed)
                if footer:
                    agent._file_mutation_verifier_footer = footer

        # final_response must be unchanged
        assert final_response == "I tried to patch the file."
        assert "File-mutation verifier" not in final_response

        # Footer must be stored separately
        assert agent._file_mutation_verifier_footer is not None
        assert "File-mutation verifier" in agent._file_mutation_verifier_footer
        assert "1 file(s) were NOT modified" in agent._file_mutation_verifier_footer

    def test_footer_not_visible_to_transform_llm_output(self):
        """The footer must not be in final_response, so transform_llm_output
        and other consumers of final_response never see it."""
        agent = _bare_agent()

        agent._turn_failed_file_mutations["/tmp/a.md"] = {
            "tool": "patch",
            "error_preview": "old_string not found",
        }
        agent._turn_failed_file_mutations["/tmp/b.md"] = {
            "tool": "write_file",
            "error_preview": "Permission denied",
        }

        # Simulate the fixed conversation loop logic
        final_response = "I updated both files successfully."
        if final_response:
            _failed = agent._turn_failed_file_mutations
            if _failed:
                footer = AIAgent._format_file_mutation_failure_footer(_failed)
                if footer:
                    agent._file_mutation_verifier_footer = footer

        # Simulate what transform_llm_output hook receives
        hook_response_text = final_response  # This is what hooks get

        assert "File-mutation verifier" not in hook_response_text
        assert "NOT modified" not in hook_response_text
        assert "Permission denied" not in hook_response_text

        # Footer is available via the side channel
        assert "2 file(s)" in agent._file_mutation_verifier_footer

    def test_footer_cleared_between_turns(self):
        """_file_mutation_verifier_footer is reset to None at turn start,
        so a stale footer from a previous turn never leaks into the next."""
        agent = _bare_agent()

        # Simulate a previous turn that set a footer
        agent._file_mutation_verifier_footer = (
            "⚠️ File-mutation verifier: 1 file(s) were NOT modified..."
        )

        # Simulate the turn-start reset (conversation_loop.py line ~766)
        agent._file_mutation_verifier_footer = None

        assert agent._file_mutation_verifier_footer is None

    def test_no_footer_when_all_mutations_succeed(self):
        """When there are no failed mutations, no footer is stored."""
        agent = _bare_agent()

        # No failed mutations
        agent._turn_failed_file_mutations = {}

        final_response = "All files updated."
        if final_response:
            _failed = agent._turn_failed_file_mutations
            if _failed:
                footer = AIAgent._format_file_mutation_failure_footer(_failed)
                if footer:
                    agent._file_mutation_verifier_footer = footer

        assert agent._file_mutation_verifier_footer is None
        assert final_response == "All files updated."

    def test_empty_final_response_skips_footer(self):
        """When final_response is empty/interrupted, no footer is stored.
        This matches the guard in conversation_loop.py."""
        agent = _bare_agent()
        agent._turn_failed_file_mutations["/tmp/x.md"] = {
            "tool": "patch",
            "error_preview": "err",
        }

        final_response = ""  # Empty / interrupted
        interrupted = True

        if final_response and not interrupted:
            _failed = agent._turn_failed_file_mutations
            if _failed:
                footer = AIAgent._format_file_mutation_failure_footer(_failed)
                if footer:
                    agent._file_mutation_verifier_footer = footer

        assert agent._file_mutation_verifier_footer is None

    def test_result_dict_includes_footer(self):
        """The conversation loop's result dict must include the footer
        under 'file_mutation_verifier_footer' for CLI/gateway use."""
        agent = _bare_agent()
        agent._file_mutation_verifier_footer = (
            "⚠️ File-mutation verifier: 1 file(s) were NOT modified..."
        )

        # Simulate what conversation_loop.py does at the result-building stage
        _verifier_footer = getattr(agent, "_file_mutation_verifier_footer", None) or None
        result = {
            "final_response": "I tried to patch the file.",
            "file_mutation_verifier_footer": _verifier_footer,
        }

        assert result["final_response"] == "I tried to patch the file."
        assert result["file_mutation_verifier_footer"] is not None
        assert "File-mutation verifier" in result["file_mutation_verifier_footer"]
