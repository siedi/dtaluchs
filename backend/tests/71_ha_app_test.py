"""The app for Home Assistant in contrib/home-assistant: config.yaml and the start script run.py."""

import importlib.util
import json
import os
import tomllib
from pathlib import Path
from types import ModuleType

import pytest
import yaml

APP = Path(__file__).resolve().parents[2] / "contrib" / "home-assistant" / "dtaluchs"
PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def load_run() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ha_run", APP / "run.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


run = load_run()


def test_config_has_every_key_of_rule_7() -> None:
    config = yaml.safe_load((APP / "config.yaml").read_text(encoding="utf-8"))
    version = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]["version"]
    assert config["version"] == version
    assert {k: config[k] for k in ("slug", "arch", "init", "ingress", "ingress_port")} == {
        "slug": "dtaluchs",
        "arch": ["aarch64", "amd64"],
        "init": True,
        "ingress": True,
        "ingress_port": 8470,
    }
    assert "ports" not in config
    assert "panel_admin" not in config
    assert config["panel_icon"] == "mdi:heat-pump"
    assert config["panel_title"] == "DTA-Luchs"
    assert config["environment"] == {"ALLOW_FROM": "172.30.32.2"}
    assert config["backup"] == "cold"
    assert config["backup_exclude"] == ["tmp/*"]
    assert config["tmpfs"] is True
    assert config["timeout"] == 15
    assert config["watchdog"] == "http://[HOST]:[PORT:8470]/"
    assert config["options"] == {}
    assert set(config["schema"]) == set(run.OPTIONS)
    assert all(kind.endswith("?") for kind in config["schema"].values())


def test_every_option_has_a_text_in_both_languages() -> None:
    config = yaml.safe_load((APP / "config.yaml").read_text(encoding="utf-8"))
    for language in ("de", "en"):
        texts = yaml.safe_load((APP / "translations" / f"{language}.yaml").read_text("utf-8"))
        assert set(texts["configuration"]) == set(config["schema"])


def test_without_options_json_there_are_no_options(tmp_path: Path) -> None:
    assert run.read_options(tmp_path / "options.json") == {}


def test_options_become_variables(tmp_path: Path) -> None:
    path = tmp_path / "options.json"
    path.write_text(json.dumps({"timezone": "Europe/Vienna", "duckdb_memory_mb": 512}))
    env = run.environment(run.read_options(path), "Europe/Berlin")
    assert env == {"TIMEZONE": "Europe/Vienna", "DUCKDB_MEMORY_MB": "512"}


@pytest.mark.parametrize(
    ("options", "tz", "env"),
    [
        ({}, "Europe/Amsterdam", {"TIMEZONE": "Europe/Amsterdam"}),
        ({"timezone": ""}, "Europe/Amsterdam", {"TIMEZONE": "Europe/Amsterdam"}),
        ({}, "", {}),
    ],
)
def test_without_a_zone_the_one_of_home_assistant(
    options: dict[str, object], tz: str, env: dict[str, str]
) -> None:
    assert run.environment(options, tz) == env


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("{nope", "ist nicht lesbar"),
        ("[1]", "enthält kein Objekt."),
        ('{"timezone": 5}', "„timezone“ ist kein str: 5"),
        ('{"duckdb_memory_mb": "512"}', "„duckdb_memory_mb“ ist kein int: '512'"),
        ('{"duckdb_memory_mb": true}', "„duckdb_memory_mb“ ist kein int: True"),
    ],
)
def test_a_broken_file_names_itself(tmp_path: Path, text: str, message: str) -> None:
    path = tmp_path / "options.json"
    path.write_text(text)
    with pytest.raises(run.OptionsError) as err:
        run.read_options(path)
    assert str(err.value).startswith(str(path))
    assert message in str(err.value)


def test_a_broken_file_ends_the_start_with_code_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "options.json").write_text("{nope")
    monkeypatch.setattr(run, "DATA", tmp_path)
    with pytest.raises(SystemExit) as end:
        run.main()
    assert end.value.code == 2
    assert capsys.readouterr().err.startswith(
        f"dtaluchs: {tmp_path / 'options.json'} ist nicht lesbar"
    )


def test_a_folder_of_the_right_owner_stays_as_it_is(tmp_path: Path) -> None:
    (tmp_path / "meta.duckdb").write_text("")
    assert run.take_over(tmp_path, os.getuid(), os.getgid()) is False


def test_the_folder_itself_goes_last(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "upload").mkdir()
    (tmp_path / "meta.duckdb").write_text("")
    calls: list[Path] = []
    monkeypatch.setattr(run.os, "chown", lambda path, *_, **__: calls.append(Path(path)))
    assert run.take_over(tmp_path, os.getuid() + 1, os.getgid()) is True
    assert set(calls[:-1]) == {tmp_path / "upload", tmp_path / "meta.duckdb"}
    assert calls[-1] == tmp_path


def test_a_failed_take_over_ends_the_start_with_code_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def refuse(*_: object, **__: object) -> None:
        raise PermissionError("nein")

    monkeypatch.setattr(run, "DATA", tmp_path)
    monkeypatch.setattr(run, "UID", os.getuid() + 1)
    monkeypatch.setattr(run.os, "getuid", lambda: 0)
    monkeypatch.setattr(run.os, "chown", refuse)
    with pytest.raises(SystemExit) as end:
        run.main()
    assert end.value.code == 2
    assert "lässt sich nicht UID" in capsys.readouterr().err
