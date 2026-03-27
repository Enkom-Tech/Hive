"""
Unit tests for RepoWatcher — verifies the asyncio threading fix.
Specifically:
  - on_modified must call asyncio.run_coroutine_threadsafe (NOT asyncio.create_task)
  - debounce logic: rapid double-modification triggers only one index call
"""

import asyncio
import threading
import unittest.mock as mock
import pytest

from cocoindex_server import RepoWatcher, CodeChunker


class FakeEvent:
    def __init__(self, path: str, is_directory: bool = False):
        self.src_path = path
        self.is_directory = is_directory


class FakeIndexer:
    def __init__(self):
        self.indexed_files: list = []
        self._lock = threading.Lock()

    async def index_file(self, file_path: str):
        with self._lock:
            self.indexed_files.append(file_path)


def _discard_unscheduled_coroutine(coro, _loop):
    """Simulate scheduling without running: close coroutine to avoid 'never awaited' warnings."""
    if asyncio.iscoroutine(coro):
        coro.close()
    return mock.MagicMock()


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


class TestRepoWatcherThreadSafe:
    def test_on_modified_uses_run_coroutine_threadsafe(self, event_loop):
        """on_modified must schedule via run_coroutine_threadsafe, not create_task."""
        indexer = FakeIndexer()
        watcher = RepoWatcher(indexer, event_loop)

        with mock.patch("asyncio.run_coroutine_threadsafe") as mock_schedule:
            mock_schedule.side_effect = _discard_unscheduled_coroutine
            event = FakeEvent("src/main.py")
            watcher.on_modified(event)

        mock_schedule.assert_called_once()
        _, kwargs_or_args = mock_schedule.call_args[0], mock_schedule.call_args
        # Verify the event loop was passed
        assert event_loop in mock_schedule.call_args[0]

    def test_on_modified_ignores_directories(self, event_loop):
        indexer = FakeIndexer()
        watcher = RepoWatcher(indexer, event_loop)

        with mock.patch("asyncio.run_coroutine_threadsafe") as mock_schedule:
            event = FakeEvent("src/", is_directory=True)
            watcher.on_modified(event)

        mock_schedule.assert_not_called()

    def test_on_modified_ignores_non_code_files(self, event_loop):
        indexer = FakeIndexer()
        watcher = RepoWatcher(indexer, event_loop)

        with mock.patch("asyncio.run_coroutine_threadsafe") as mock_schedule:
            event = FakeEvent("README.md")
            watcher.on_modified(event)

        mock_schedule.assert_not_called()

    def test_on_modified_processes_code_files(self, event_loop):
        indexer = FakeIndexer()
        watcher = RepoWatcher(indexer, event_loop)

        supported_files = ["src/app.py", "src/lib.ts", "src/main.go", "src/lib.rs"]
        with mock.patch("asyncio.run_coroutine_threadsafe") as mock_schedule:
            mock_schedule.side_effect = _discard_unscheduled_coroutine
            for f in supported_files:
                watcher.on_modified(FakeEvent(f))

        assert mock_schedule.call_count == len(supported_files)


class TestRepoWatcherDebounce:
    @pytest.mark.asyncio
    async def test_debounce_prevents_double_indexing(self):
        """Rapid double-modification of same file triggers only one index call."""
        loop = asyncio.get_running_loop()
        indexer = FakeIndexer()
        watcher = RepoWatcher(indexer, loop)

        file_path = "src/main.py"

        # Schedule two concurrent _queue_index calls for same file
        await asyncio.gather(
            watcher._queue_index(file_path),
            watcher._queue_index(file_path),
        )

        # Only one indexing call should happen (debounce)
        assert indexer.indexed_files.count(file_path) == 1

    @pytest.mark.asyncio
    async def test_different_files_are_both_indexed(self):
        """Two different files modified together are both indexed."""
        loop = asyncio.get_running_loop()
        indexer = FakeIndexer()
        watcher = RepoWatcher(indexer, loop)

        await asyncio.gather(
            watcher._queue_index("src/a.py"),
            watcher._queue_index("src/b.py"),
        )

        assert "src/a.py" in indexer.indexed_files
        assert "src/b.py" in indexer.indexed_files
