"""The folder of synthetic DTA files holds exactly what `synthetic_support.py` writes, so no file of a real plant gets in."""

from synthetic_support import FOLDER, files


def test_the_folder_holds_exactly_the_generated_files() -> None:
    on_disk = {
        p.relative_to(FOLDER).as_posix(): p.read_bytes()
        for p in FOLDER.rglob("*")
        if p.is_file() and not p.name.startswith(".")  # .DS_Store and the like
    }
    generated = files()
    assert sorted(on_disk) == sorted(generated), (
        "uv run python tests/synthetic_support.py schreibt den Ordner neu"
    )
    assert [name for name, data in generated.items() if on_disk[name] != data] == []
