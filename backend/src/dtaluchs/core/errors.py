"""Errors the core raises; the API translates them into HTTP status codes."""


class DtaluchsError(Exception):
    """Base error; `detail` is German and shown to the user as is."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class NotFound(DtaluchsError):
    """The requested object does not exist."""


class Invalid(DtaluchsError):
    """The request is well-formed but not acceptable."""


class Unavailable(DtaluchsError):
    """A source the request needs is missing or not reachable."""


class SpillUnavailable(Unavailable):
    """The folder DuckDB spills into cannot be made; no query can run until it is fixed."""


class NoImport(Unavailable):
    """`meta.duckdb` does not exist yet: nothing has been imported."""


class WriterBusy(Unavailable):
    """The import holds `meta.duckdb` for writing; the window is short, waiting helps."""


class Forbidden(DtaluchsError):
    """The object exists but must not be changed this way."""


class Conflict(DtaluchsError):
    """The request clashes with the current state, e.g. a name that is already taken."""


class TooLarge(DtaluchsError):
    """The request body exceeds the limit."""
