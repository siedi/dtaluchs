import json
import threading
from pathlib import Path

import pytest

from dtaluchs.core.errors import NotFound
from dtaluchs.core.plantdir import NO_PLANT
from dtaluchs.core.runtime_settings import FetchSettings, check_address, load_fetch, save_fetch
from dtaluchs.core.settings import CONFIG_ENV, ConfigError, Settings
from dtaluchs.core.stock.names import SETTINGS_FILE

DEFAULTS = FetchSettings("", False)


def test_missing_file_gives_defaults(tmp_path: Path) -> None:
    value, error = load_fetch(tmp_path)
    assert value == DEFAULTS
    assert error is None


@pytest.mark.parametrize(
    "content",
    ["{kaputt", '{"fetch": []}', "[]", '{"fetch": {"address": 5, "enabled": false}}',
     '{"fetch": {"address": "wp", "enabled": "ja"}}', '{"fetch": {"address": "wp"}}'],
)  # fmt: skip
def test_broken_file_names_file_and_error(tmp_path: Path, content: str) -> None:
    (tmp_path / SETTINGS_FILE).write_text(content)
    value, error = load_fetch(tmp_path)
    assert value == DEFAULTS
    assert error is not None
    assert SETTINGS_FILE in error
    assert str(tmp_path) in error


def test_deeply_nested_file_is_an_error_and_is_replaced_by_save(tmp_path: Path) -> None:
    (tmp_path / SETTINGS_FILE).write_text("[" * 200_000)  # json.loads: RecursionError
    value, error = load_fetch(tmp_path)
    assert value == DEFAULTS
    assert error is not None
    assert SETTINGS_FILE in error
    assert save_fetch(tmp_path, FetchSettings("wp", True)) == DEFAULTS
    assert load_fetch(tmp_path) == (FetchSettings("wp", True), None)


def test_error_text_says_what_makes_the_fetch_run_again(tmp_path: Path) -> None:
    (tmp_path / SETTINGS_FILE).write_text("{kaputt")
    _, error = load_fetch(tmp_path)
    assert error is not None
    assert error.endswith(
        "Der Abruf ruht, bis die Datei repariert ist (wirksam mit dem nächsten Lauf im Server "
        "oder nach einem Neustart) "
        "oder die Einstellung in der Oberfläche neu gespeichert wird."
    )


def test_unreadable_file_names_file_and_error(tmp_path: Path) -> None:
    (tmp_path / SETTINGS_FILE).mkdir()  # a folder in place of the file
    value, error = load_fetch(tmp_path)
    assert value == DEFAULTS
    assert error is not None
    assert SETTINGS_FILE in error


def test_save_is_atomic(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    first = FetchSettings("wp.local", True)
    save_fetch(tmp_path, first)
    assert sorted(p.name for p in tmp_path.iterdir()) == [SETTINGS_FILE]
    assert load_fetch(tmp_path) == (first, None)
    before = (tmp_path / SETTINGS_FILE).read_bytes()

    def broken(self: Path, target: object) -> None:
        raise OSError("Unterbrochen")

    monkeypatch.setattr(Path, "replace", broken)
    with pytest.raises(OSError, match="Unterbrochen"):
        save_fetch(tmp_path, FetchSettings("andere", False))
    assert (tmp_path / SETTINGS_FILE).read_bytes() == before
    assert [p.name for p in tmp_path.iterdir()] == [SETTINGS_FILE]  # Zwischendatei weggeräumt


def test_concurrent_saves_do_not_share_the_temporary_file(tmp_path: Path) -> None:
    errors: list[BaseException] = []
    start = threading.Barrier(8)

    def worker(n: int) -> None:
        start.wait()
        try:
            for i in range(40):
                save_fetch(tmp_path, FetchSettings(f"wp{n}-{i}", bool(i % 2)))
        except BaseException as err:  # the test reports what a thread raised
            errors.append(err)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    value, error = load_fetch(tmp_path)
    assert error is None
    assert value.address.startswith("wp")
    assert [p.name for p in tmp_path.iterdir()] == [SETTINGS_FILE]


def test_save_returns_the_previous_state(tmp_path: Path) -> None:
    assert save_fetch(tmp_path, FetchSettings("a", True)) == DEFAULTS  # no file: the defaults
    assert save_fetch(tmp_path, FetchSettings("b", False)) == FetchSettings("a", True)
    (tmp_path / SETTINGS_FILE).write_text("{kaputt")
    assert save_fetch(tmp_path, FetchSettings("c", True)) == DEFAULTS  # broken file: the defaults


def test_save_keeps_other_top_level_keys(tmp_path: Path) -> None:
    (tmp_path / SETTINGS_FILE).write_text('{"spaeter": {"x": 1}, "fetch": {"address": "a"}}')
    save_fetch(tmp_path, FetchSettings("wp", True))
    data = json.loads((tmp_path / SETTINGS_FILE).read_text())
    assert data == {"spaeter": {"x": 1}, "fetch": {"address": "wp", "enabled": True}}


def test_save_replaces_broken_file(tmp_path: Path) -> None:
    (tmp_path / SETTINGS_FILE).write_text("{kaputt")
    save_fetch(tmp_path, FetchSettings("wp", True))
    assert load_fetch(tmp_path) == (FetchSettings("wp", True), None)


def test_save_without_data_dir_is_not_found_and_makes_nothing(tmp_path: Path) -> None:
    # A plant deleted meanwhile does not come back through its settings.
    with pytest.raises(NotFound, match=NO_PLANT):
        save_fetch(tmp_path / "neu", FetchSettings("wp", False))
    assert not (tmp_path / "neu").exists()


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("192.168.1.30", "192.168.1.30"),
        ("wp.local:8080", "wp.local:8080"),
        ("[fe80::1]:80", "[fe80::1]:80"),
        ("  wp  ", "wp"),
        ("[fe80::1]", "[fe80::1]"),
    ],
)
def test_check_address_valid(text: str, expected: str) -> None:
    assert check_address(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "http://wp",
        "wp/NewProc",
        "a b",
        "wp:0",
        "wp:65536",
        "user@wp",
        "",
        "   ",
        "fe80::1",
        "[fe80::1%eth0]",
    ],
)
def test_check_address_invalid(text: str) -> None:
    with pytest.raises(ValueError, match="Adresse"):
        check_address(text)


def write_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    path = tmp_path / "dtaluchs.toml"
    path.write_text(text)
    monkeypatch.setenv(CONFIG_ENV, str(path))


def test_fetch_enabled_from_toml_and_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings().fetch_enabled is True
    write_config(tmp_path, monkeypatch, "[fetch]\nenabled = false\n")
    assert Settings().fetch_enabled is False
    write_config(tmp_path, monkeypatch, "[fetch]\nenabled = true\n")
    monkeypatch.setenv("FETCH_ENABLED", "0")
    assert Settings().fetch_enabled is False


def test_web_read_only_from_toml_and_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings().web_read_only is False
    write_config(tmp_path, monkeypatch, "[web]\nread_only = true\n")
    assert Settings().web_read_only is True
    write_config(tmp_path, monkeypatch, "[web]\nread_only = false\n")
    monkeypatch.setenv("WEB_READ_ONLY", "1")
    assert Settings().web_read_only is True
    write_config(tmp_path, monkeypatch, "[web]\nread_only = true\n")
    monkeypatch.setenv("WEB_READ_ONLY", "false")
    assert Settings().web_read_only is False


def test_unknown_key_under_web_is_config_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "[web]\nread_only = true\nreadonly = true\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "Zeile 3" in str(err.value)
    assert "readonly" in str(err.value)
    assert "[web]" in str(err.value)


def test_invalid_web_read_only_names_the_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, '[web]\nread_only = "vielleicht"\n')
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "[web] read_only" in str(err.value)
    assert "Zeile 2" in str(err.value)


def test_unknown_key_under_fetch_is_config_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "[fetch]\nenabled = true\ntimeout = 5\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "Zeile 3" in str(err.value)
    assert "timeout" in str(err.value)


def test_the_file_name_stays() -> None:
    """The name is part of the stock: a host or a backup may know it."""
    assert SETTINGS_FILE == "settings.json"


def test_blank_address_in_file_reads_as_empty_address(tmp_path: Path) -> None:
    (tmp_path / SETTINGS_FILE).write_text('{"fetch": {"address": " ", "enabled": true}}')
    assert load_fetch(tmp_path) == (FetchSettings("", True), None)
