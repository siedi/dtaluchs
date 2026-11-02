import asyncio
import signal
import sys
from collections.abc import Sequence

import pytest

from dtaluchs.core.store import child
from dtaluchs.core.store.child import MAX_LINE


class Blocks:
    """A stream that hands out the given blocks one by one, as a pipe does."""

    def __init__(self, blocks: Sequence[bytes]) -> None:
        self._blocks = list(blocks)

    async def read(self, n: int) -> bytes:
        return self._blocks.pop(0) if self._blocks else b""


async def lines(*blocks: bytes) -> list[tuple[str, bool]]:
    return [item async for item in child.lines(Blocks(blocks))]


async def test_a_line_split_over_blocks_comes_out_whole() -> None:
    assert await lines(b"ab", b"c\nd", b"e\n") == [("abc", False), ("de", False)]


async def test_crlf_endings_are_stripped() -> None:
    assert await lines(b"a\r\nb\r\n") == [("a", False), ("b", False)]
    assert await lines(b"a\r", b"\nb\r\n") == [("a", False), ("b", False)]


async def test_a_last_line_without_an_end_is_kept() -> None:
    assert await lines(b"a\nb") == [("a", False), ("b", False)]


async def test_nothing_comes_out_of_an_empty_stream() -> None:
    assert await lines() == []
    assert await lines(b"") == []


async def test_a_utf8_character_split_at_the_block_border_is_decoded_whole() -> None:
    umlaut = "ü".encode()
    assert await lines(b"gr" + umlaut[:1], umlaut[1:] + b"n\n") == [("grün", False)]


async def test_a_line_over_the_limit_is_cut_and_marked_however_the_blocks_fall() -> None:
    long = b"x" * (MAX_LINE * 3)
    [(text, cut)] = await lines(long[:5000], long[5000:] + b"\n")
    assert (len(text), cut) == (MAX_LINE, True)
    assert await lines(b"y" * MAX_LINE + b"\n") == [("y" * MAX_LINE, False)]
    assert await lines(b"y" * (MAX_LINE + 1) + b"\n") == [("y" * MAX_LINE, True)]


async def test_the_line_after_a_cut_one_is_whole_again() -> None:
    assert await lines(b"z" * (MAX_LINE + 10) + b"\nok\n") == [
        ("z" * MAX_LINE, True),
        ("ok", False),
    ]


async def test_the_last_line_that_is_not_empty_wins() -> None:
    assert await child.last_line(Blocks([b"eins\n\nzwei\n\n  \n"])) == "zwei"


@pytest.mark.parametrize("size", [300_000, 1_000_000])
async def test_a_real_pipe_with_a_huge_line_is_read_to_the_end(size: int) -> None:
    """The reader never stops emptying the pipe, which is what keeps a chatty child running."""
    reader = asyncio.StreamReader()
    reader.feed_data(b"a" * size + b"\nende\n")
    reader.feed_eof()
    assert [text for text, _ in await _collect(reader)] == ["a" * MAX_LINE, "ende"]


async def test_a_second_cancel_during_the_grace_period_still_kills_the_child() -> None:
    """Cancelled again while waiting out SIGTERM, `end` kills before it lets go."""
    # os.write, not print: SIGTERM may land while print('bereit') still holds stdout's buffer,
    # and a print in the handler then dies with "reentrant call".
    notes_term = (
        "import os, signal, time\n"
        "signal.signal(signal.SIGTERM, lambda *_: os.write(1, b'term\\n'))\n"
        "print('bereit', flush=True)\n"
        "while True: time.sleep(1)\n"
    )
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-c", notes_term, stdout=asyncio.subprocess.PIPE
    )
    try:
        assert proc.stdout is not None
        assert await proc.stdout.readline() == b"bereit\n"

        async def runs_until_cancelled() -> None:
            try:
                await asyncio.Event().wait()
            finally:
                await child.end(proc)

        task = asyncio.create_task(runs_until_cancelled())
        await asyncio.sleep(0)
        task.cancel()  # first cancel: `end` sends SIGTERM and waits the grace period
        assert await asyncio.wait_for(proc.stdout.readline(), 2) == b"term\n"
        assert proc.returncode is None
        task.cancel()  # second cancel during the grace period
        with pytest.raises(asyncio.CancelledError):
            await task
        assert await asyncio.wait_for(proc.wait(), 2) == -signal.SIGKILL
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def _collect(reader: asyncio.StreamReader) -> list[tuple[str, bool]]:
    return [item async for item in child.lines(reader)]
