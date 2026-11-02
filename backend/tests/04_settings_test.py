from pathlib import Path

import pytest

from dtaluchs.core.settings import CONFIG_ENV, REPO_ROOT, ConfigError, Settings, config_path

TOML = """\
data_dir = "d"
port = 8499

[import]
source = "/x"
interval_min = 5
"""


def write_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    path = tmp_path / "dtaluchs.toml"
    path.write_text(text)
    monkeypatch.setenv(CONFIG_ENV, str(path))


def test_toml_is_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, TOML)
    settings = Settings()
    assert settings.port == 8499
    assert settings.dta_source_dir == Path("/x")
    assert settings.import_interval_min == 5
    assert settings.data_dir == REPO_ROOT / "d"


def test_environment_wins_over_toml(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, TOML)
    monkeypatch.setenv("PORT", "8500")
    monkeypatch.setenv("IMPORT_INTERVAL_MIN", "7")
    settings = Settings()
    assert settings.port == 8500
    assert settings.import_interval_min == 7


def test_arguments_win_over_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, TOML)
    monkeypatch.setenv("PORT", "8500")
    assert Settings(port=8501).port == 8501


def test_missing_file_means_defaults() -> None:
    settings = Settings()
    assert settings.port == 8470
    assert settings.dta_source_dir is None
    assert settings.import_interval_min == 15


def test_env_file_is_not_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / ".env").write_text("PORT=8499\n")
    monkeypatch.chdir(tmp_path)
    assert Settings().port == 8470


def test_unknown_key_names_file_line_and_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, '[import]\n\nsorce = "/x"\n')
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "dtaluchs.toml" in text
    assert "Zeile 3" in text
    assert "sorce" in text


def test_unknown_table_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, "[serve]\nport = 1\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "serve" in str(err.value)


def test_broken_syntax_names_line(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, "port = 1\nport 2\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "dtaluchs.toml" in text
    assert "Zeile 2" in text
    assert "Syntaxfehler" in text
    assert "Expected" in text  # the original message of tomllib stays in brackets


def test_wrong_type_in_the_file_names_key_and_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, 'data_dir = "d"\nport = "x"\n')
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "dtaluchs.toml, Zeile 2" in text
    assert "„port“" in text


def test_wrong_type_of_an_import_key_names_its_line_not_that_of_a_same_named_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, 'port = 1\n\n[import]\ninterval_min = "x"\n')
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "dtaluchs.toml, Zeile 4" in text
    assert "„[import] interval_min“" in text


def test_wrong_type_from_the_environment_names_the_variable_not_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "port = 8499\n")
    monkeypatch.setenv("PORT", "x")
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "Umgebungsvariable PORT" in text
    assert "dtaluchs.toml" not in text


def test_wrong_type_from_an_argument_names_the_argument(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "port = 8499\n")
    with pytest.raises(ConfigError) as err:
        Settings(port="x")
    assert "Argument" in str(err.value)
    assert "dtaluchs.toml" not in str(err.value)


def test_unknown_key_at_the_top_names_file_line_and_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "port = 1\nbogus = 2\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "dtaluchs.toml, Zeile 2" in text
    assert "bogus" in text


def test_import_that_is_no_table_is_rejected_with_its_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "port = 1\nimport = 1\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "dtaluchs.toml, Zeile 2" in str(err.value)
    assert "Tabelle" in str(err.value)


def test_a_key_of_the_same_name_in_another_table_does_not_give_the_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`port` is valid at the top, not in [import]; the line is the one inside the table."""
    write_config(tmp_path, monkeypatch, "port = 1\n\n[import]\nport = 2\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "Zeile 4" in str(err.value)
    assert "„port“" in str(err.value)


def test_a_line_that_cannot_be_found_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "import = { sorce = 1 }\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "sorce" in text
    assert "Zeile" in text


def test_negative_interval_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, "[import]\ninterval_min = -5\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "interval_min" in str(err.value)


def test_empty_source_means_no_source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, '[import]\nsource = ""\n')
    assert Settings().dta_source_dir is None


def test_relative_paths_resolve_against_repo_root() -> None:
    assert Settings(data_dir=Path("data-wt")).data_dir == REPO_ROOT / "data-wt"


@pytest.mark.parametrize("name", ["PORT", "IMPORT_INTERVAL_MIN", "DATA_DIR"])
def test_an_empty_variable_is_not_set(
    name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, TOML)
    monkeypatch.setenv(name, "")
    settings = Settings()
    assert (settings.port, settings.import_interval_min) == (8499, 5)
    assert settings.data_dir == REPO_ROOT / "d"


def test_an_empty_source_variable_overrides_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The runner passes `DTA_SOURCE_DIR=` to the child to say: no path, whatever the file says."""
    write_config(tmp_path, monkeypatch, TOML)
    monkeypatch.setenv("DTA_SOURCE_DIR", "")
    assert Settings().dta_source_dir is None


def test_a_relative_config_path_resolves_against_the_repo_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CONFIG_ENV, "relativ-dtaluchs.toml")
    monkeypatch.chdir(tmp_path)
    assert config_path() == REPO_ROOT / "relativ-dtaluchs.toml"


def test_wrong_type_in_the_file_is_named_so_when_the_variable_is_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, 'port = "abc"\n')
    monkeypatch.setenv("PORT", "")
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "dtaluchs.toml, Zeile 1" in text
    assert "Umgebungsvariable" not in text


def test_host_from_the_file_is_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, 'host = "0.0.0.0"\n')
    assert Settings().host == "0.0.0.0"


def test_host_environment_wins_over_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, 'host = "0.0.0.0"\n')
    monkeypatch.setenv("HOST", "10.0.0.1")
    assert Settings().host == "10.0.0.1"


def test_host_argument_wins_over_the_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, 'host = "0.0.0.0"\n')
    monkeypatch.setenv("HOST", "10.0.0.1")
    assert Settings(host="10.0.0.2").host == "10.0.0.2"


def test_host_defaults_to_loopback() -> None:
    assert Settings().host == "127.0.0.1"


def test_an_empty_host_variable_is_not_set(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, 'host = "0.0.0.0"\n')
    monkeypatch.setenv("HOST", "")
    assert Settings().host == "0.0.0.0"


@pytest.mark.parametrize("value", ["", "  "])
def test_a_blank_host_in_the_file_is_the_default(
    value: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """uvicorn binds an empty host to every interface; blank means not set, as `source = ""`."""
    write_config(tmp_path, monkeypatch, f'host = "{value}"\n')
    assert Settings().host == "127.0.0.1"


def test_duckdb_limits_default_to_one_gib_and_four_threads() -> None:
    settings = Settings()
    assert (settings.duckdb_memory_mb, settings.duckdb_threads) == (1024, 4)


def test_duckdb_limits_come_from_the_toml_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "[duckdb]\nmemory_mb = 512\nthreads = 2\n")
    settings = Settings()
    assert (settings.duckdb_memory_mb, settings.duckdb_threads) == (512, 2)


def test_duckdb_limits_from_the_environment_win_and_empty_ones_do_not_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "[duckdb]\nmemory_mb = 512\nthreads = 2\n")
    monkeypatch.setenv("DUCKDB_MEMORY_MB", "256")
    monkeypatch.setenv("DUCKDB_THREADS", "")
    settings = Settings()
    assert (settings.duckdb_memory_mb, settings.duckdb_threads) == (256, 2)


def test_duckdb_temp_dir_is_unset_by_default_and_comes_from_toml_or_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert Settings().duckdb_temp_dir is None
    write_config(tmp_path, monkeypatch, f'[duckdb]\ntemp_dir = "{tmp_path / "aus-toml"}"\n')
    assert Settings().duckdb_temp_dir == tmp_path / "aus-toml"
    monkeypatch.setenv("DUCKDB_TEMP_DIR", str(tmp_path / "aus-env"))
    assert Settings().duckdb_temp_dir == tmp_path / "aus-env"


def test_an_empty_duckdb_temp_dir_is_unset_and_a_relative_one_follows_the_repo_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, '[duckdb]\ntemp_dir = ""\n')
    assert Settings().duckdb_temp_dir is None
    monkeypatch.setenv("DUCKDB_TEMP_DIR", "spill-wt")
    assert Settings().duckdb_temp_dir == REPO_ROOT / "spill-wt"


def test_parallel_field_statistics_default_to_one_and_come_from_toml_or_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert Settings().field_stats_parallel == 1
    write_config(tmp_path, monkeypatch, "[field_stats]\nparallel = 3\n")
    assert Settings().field_stats_parallel == 3
    monkeypatch.setenv("FIELD_STATS_PARALLEL", "2")
    assert Settings().field_stats_parallel == 2


def test_no_parallel_field_statistics_names_key_and_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "[field_stats]\nparallel = 0\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "dtaluchs.toml, Zeile 2" in str(err.value)
    assert "„[field_stats] parallel“" in str(err.value)


def test_unknown_key_in_the_duckdb_table_names_file_line_and_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "port = 1\n\n[duckdb]\nmemory = 5\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "dtaluchs.toml, Zeile 4" in str(err.value)
    assert "„memory“ in [duckdb]" in str(err.value)


def test_duckdb_as_a_plain_value_is_not_a_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, "duckdb = 5\n")
    with pytest.raises(ConfigError, match="muss eine Tabelle"):
        Settings()


@pytest.mark.parametrize("value", ["0", '"x"', "-3"])
def test_invalid_duckdb_value_from_the_toml_names_key_and_line(
    value: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, f"[duckdb]\nthreads = {value}\n")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "dtaluchs.toml, Zeile 2" in str(err.value)
    assert "„[duckdb] threads“" in str(err.value)


@pytest.mark.parametrize("value", ["0", "x"])
def test_invalid_duckdb_value_from_the_environment_names_the_variable(
    value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DUCKDB_MEMORY_MB", value)
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "Umgebungsvariable DUCKDB_MEMORY_MB" in str(err.value)
    assert "„[duckdb] memory_mb“" in str(err.value)


@pytest.mark.parametrize("port", ["0", "-5", "99999"])
def test_a_port_outside_1_to_65535_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, port: str
) -> None:
    write_config(tmp_path, monkeypatch, "")
    monkeypatch.setenv("PORT", port)
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "PORT" in str(err.value)
